import { randomUUID } from 'node:crypto'
// Anthropic API provider — direct fetch, agentic tool loop, config-driven
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { createLogger } from '../logger.js'
import { type ToolContext, executeLoop, getToolDefinitions } from '../tools/index.js'
import type { StepInput, StepOutput, StepProvider } from './index.js'
import { loadProviderConfig, resolveStepSettings } from './index.js'
import '../tools/fs.js' // register filesystem tools
import '../tools/github.js' // register GitHub tools

// Per-agent providerConfig shape for this provider. Kept private to the
// provider file so shared/ stays agnostic. Strict → extra fields (e.g.
// terminal flags) are rejected at runtime.
const AnthropicApiAgentConfigSchema = z
  .object({
    model: z.string().optional(),
    maxTokens: z.number().int().positive().optional(),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
    taskBudgetTokens: z.number().int().min(20000).optional(),
    maxIters: z.number().int().positive().optional(),
  })
  .strict()

function parseAgentConfig(raw: unknown): z.infer<typeof AnthropicApiAgentConfigSchema> | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = AnthropicApiAgentConfigSchema.safeParse(raw)
  return r.success ? r.data : undefined
}

const log = createLogger('anthropic-api')

const API_URL = 'https://api.anthropic.com/v1/messages'
const LOGS_DIR = join(import.meta.dir, '..', '..', 'logs', 'contexts')

function buildAuthHeader(): Record<string, string> {
  const oauthToken = Bun.env.CLAUDE_CODE_OAUTH_TOKEN
  const apiKey = Bun.env.ANTHROPIC_API_KEY
  if (oauthToken) return { Authorization: `Bearer ${oauthToken}` }
  if (apiKey) return { 'x-api-key': apiKey }
  throw new Error('No auth configured: set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY')
}

function authLabel(): string {
  if (Bun.env.CLAUDE_CODE_OAUTH_TOKEN) return 'CLAUDE_CODE_OAUTH_TOKEN'
  if (Bun.env.ANTHROPIC_API_KEY) return 'ANTHROPIC_API_KEY'
  return 'none'
}

export function interpolate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match,
  )
}

async function logContext(
  runId: string,
  taskTitle: string,
  requestBody: object,
  responseText: string,
): Promise<void> {
  try {
    await mkdir(LOGS_DIR, { recursive: true })
    const slug = taskTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 40)
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const path = join(LOGS_DIR, `${ts}-${slug}.md`)
    const content = [
      `# ${taskTitle}`,
      `_${new Date().toISOString()}_ · runId: ${runId}`,
      '',
      '## Request',
      '```json',
      JSON.stringify(requestBody, null, 2),
      '```',
      '',
      '## Response',
      '```',
      responseText,
      '```',
    ].join('\n')
    await writeFile(path, content, 'utf-8')
    log.info({ event: 'agent.context_logged', runId, path }, 'Context logged')
  } catch (e) {
    log.warn({ event: 'agent.context_log_failed', runId, err: e }, 'Failed to log context')
  }
}

export const anthropicApiProvider: StepProvider = {
  id: 'anthropic-api',
  name: 'Claude API (headless)',
  description:
    'Direct fetch to Anthropic API. Supports streaming + thinking. All config via providers.json.',

  async run(input: StepInput): Promise<StepOutput> {
    const runId = randomUUID().slice(0, 8)
    const logCtx = { runId, taskId: input.taskId, task: input.taskTitle }

    const config = await loadProviderConfig()
    const { settings: cfg } = resolveStepSettings(input.step, config)
    const authHeader = buildAuthHeader()

    // Per-agent override — validated against this provider's private schema.
    const pc = parseAgentConfig(input.providerConfig)

    const resolvedModel = pc?.model ?? cfg.model
    const resolvedMaxTokens = pc?.maxTokens ?? cfg.maxTokens ?? 32000
    const resolvedEffort = pc?.effort ?? cfg.effort
    const resolvedTaskBudget = pc?.taskBudgetTokens
    const resolvedMaxIters = pc?.maxIters ?? input.maxIters ?? cfg.maxIters ?? 15

    const betaHeaders = new Set(cfg.anthropicBeta)
    if (resolvedTaskBudget != null) betaHeaders.add('task-budgets-2026-03-13')

    const vars: Record<string, string> = {
      task_title: input.taskTitle,
      task_description: input.taskDescription,
      task_type: input.taskType,
      repos: input.repos.join(', '),
      response_language: cfg.responseLanguage ?? '',
    }

    const agentBlocks = (input.systemPromptBlocks ?? []).map((block) => ({
      ...block,
      cache_control: { type: 'ephemeral' as const },
    }))

    const systemBlocks = [
      ...agentBlocks,
      ...cfg.systemPrompt.map((block) => ({
        ...block,
        text: interpolate(block.text, vars),
        cache_control: { type: 'ephemeral' as const },
      })),
    ]

    const headers = {
      'content-type': 'application/json',
      'anthropic-version': cfg.anthropicVersion,
      'anthropic-beta': [...betaHeaders].join(','),
      ...authHeader,
    }

    const allToolDefs = getToolDefinitions()
    // undefined → all tools; [] → no tools; ['name'] → filtered
    const toolDefs =
      input.tools === undefined
        ? allToolDefs
        : allToolDefs.filter((t) => input.tools!.includes(t.name))

    const toolCtx: ToolContext = {
      repoPaths: Object.fromEntries(input.contexts.map((c) => [c.name, c.path])),
      ...input.githubToolContext,
    }

    log.info(
      {
        event: 'agent.start',
        ...logCtx,
        model: resolvedModel,
        auth: authLabel(),
        tools: toolDefs.map((t) => t.name),
        repos: Object.keys(toolCtx.repoPaths),
      },
      'Agent run started',
    )
    log.debug(
      { event: 'agent.prompt', ...logCtx, system: systemBlocks, userPrompt: input.prompt },
      'Initial request context',
    )

    let totalIters = 0

    const fetchApi = async (messages: any[]) => {
      const iter = totalIters + 1
      const body: Record<string, unknown> = {
        model: resolvedModel,
        max_tokens: resolvedMaxTokens,
        system: systemBlocks,
        messages,
      }
      if (toolDefs.length > 0) body.tools = toolDefs
      if (cfg.thinking) body.thinking = cfg.thinking

      const outputConfig: Record<string, unknown> = {}
      if (resolvedEffort) outputConfig.effort = resolvedEffort
      if (resolvedTaskBudget != null)
        outputConfig.task_budget = { type: 'tokens', total: resolvedTaskBudget }
      if (Object.keys(outputConfig).length > 0) body.output_config = outputConfig

      log.debug(
        { event: 'api.request', ...logCtx, iter, messageCount: messages.length },
        'Anthropic request',
      )

      const t0 = Date.now()
      const res = await fetch(API_URL, { method: 'POST', headers, body: JSON.stringify(body) })
      const ms = Date.now() - t0
      log.debug(
        { event: 'api.response', ...logCtx, iter, status: res.status, ms },
        'Anthropic response',
      )

      if (!res.ok) {
        const text = await res.text()
        throw new Error(`Anthropic API ${res.status}: ${text}`)
      }
      return res.json()
    }

    const { text: rawText, iters } = await executeLoop(
      fetchApi,
      [{ role: 'user', content: input.prompt }],
      toolCtx,
      {
        maxIters: resolvedMaxIters,
        onToolCall: (name, inp) =>
          log.info({ event: 'tool.call', ...logCtx, tool: name, input: inp }, 'Tool call'),
        onToolResult: (name, result) =>
          log.info(
            { event: 'tool.result', ...logCtx, tool: name, result: result.slice(0, 500) },
            'Tool result',
          ),
      },
    )

    totalIters = iters
    log.info({ event: 'agent.complete', ...logCtx, iters }, 'Agent run complete')

    await logContext(
      runId,
      input.taskTitle,
      { model: cfg.model, tools: toolDefs.map((t) => t.name) },
      rawText,
    )

    const cleaned = rawText
      .replace(/^```(?:json)?\n?/, '')
      .replace(/\n?```$/, '')
      .trim()
    return { content: cleaned, mode: 'api' }
  },
}
