// Anthropic API provider — direct fetch, agentic tool loop, config-driven
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { StepProvider, StepInput, StepOutput } from './index.js'
import { loadProviderConfig, resolveStepSettings } from './index.js'
import { executeLoop, getToolDefinitions, type ToolContext } from '../tools/index.js'
import { createLogger } from '../logger.js'
import '../tools/fs.js'      // register filesystem tools
import '../tools/github.js'  // register GitHub tools

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

async function logContext(taskTitle: string, requestBody: object, responseText: string): Promise<void> {
  try {
    await mkdir(LOGS_DIR, { recursive: true })
    const slug = taskTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const path = join(LOGS_DIR, `${ts}-${slug}.md`)
    const content = [
      `# ${taskTitle}`,
      `_${new Date().toISOString()}_`,
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
    console.log(`[anthropic-api] context logged → ${path}`)
  } catch (e) {
    console.warn('[anthropic-api] Failed to log context:', e)
  }
}


export const anthropicApiProvider: StepProvider = {
  id: 'anthropic-api',
  name: 'Claude API (headless)',
  description: 'Direct fetch to Anthropic API. Supports streaming + thinking. All config via providers.json.',

  async run(input: StepInput): Promise<StepOutput> {
    const config = await loadProviderConfig()
    const { settings: cfg } = resolveStepSettings(input.step, config)
    const authHeader = buildAuthHeader()

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
      'anthropic-beta': cfg.anthropicBeta.join(','),
      ...authHeader,
    }

    const allToolDefs = getToolDefinitions()
    const toolDefs = input.tools?.length
      ? allToolDefs.filter(t => input.tools!.includes(t.name))
      : allToolDefs

    const toolCtx: ToolContext = {
      repoPaths: Object.fromEntries(input.contexts.map((c) => [c.name, c.path])),
      ...(input.githubToolContext),
    }

    log.info({ model: cfg.model, auth: authLabel(), tools: toolDefs.map(t => t.name), repos: Object.keys(toolCtx.repoPaths) }, 'starting agent run')
    log.debug({ system: systemBlocks, userPrompt: input.prompt }, 'initial request context')

    let totalIters = 0

    const fetchApi = async (messages: any[]) => {
      const body: Record<string, unknown> = {
        model: cfg.model,
        max_tokens: 32000,
        system: systemBlocks,
        messages,
        tools: toolDefs,
      }
      if (cfg.thinking) body.thinking = cfg.thinking

      log.debug({ iter: totalIters + 1, messageCount: messages.length, body }, 'anthropic request')

      const t0 = Date.now()
      const res = await fetch(API_URL, { method: 'POST', headers, body: JSON.stringify(body) })
      log.debug({ iter: totalIters + 1, status: res.status, ms: Date.now() - t0 }, 'anthropic response')

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
        maxIters: 15,
        onToolCall: (name, inp) => log.debug({ tool: name, input: inp }, 'tool_call'),
        onToolResult: (name, result) => log.debug({ tool: name, result: result.slice(0, 300) }, 'tool_result'),
      },
    )

    totalIters = iters
    log.info({ iters }, 'agent run complete')

    await logContext(input.taskTitle, { model: cfg.model, tools: toolDefs.map((t) => t.name) }, rawText)

    const cleaned = rawText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
    return { content: cleaned, mode: 'api' }
  },
}
