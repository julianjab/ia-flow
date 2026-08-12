import { randomUUID } from 'node:crypto'
// Anthropic API provider — direct fetch, agentic tool loop, config-driven
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type McpServers, McpServersSchema } from '@ia-flow/shared'
import { z } from 'zod'
import { loadProviderConfig, resolveStepSettings } from '../../application/provider-config.js'
import type {
  IAgentProvider,
  ProviderInput,
  ProviderOutput,
} from '../../domain/ports/IAgentProvider.js'
import { createLogger } from '../../logger.js'
import { type ToolContext, executeLoop, resolveTools } from '../../tools/index.js'
import '../../tools/fs.js' // register filesystem tools
import '../../tools/workspace.js' // register workspace tools (reset_worktree)
import '../github/tools.js' // register GitHub tools

// Per-agent providerConfig shape for this provider. Kept private to the
// provider file so shared/ stays agnostic. Strict → extra fields (e.g.
// terminal flags) are rejected at runtime.
const AnthropicApiAgentConfigSchema = z
  .object({
    model: z.string().optional(),
    maxTokens: z.number().int().positive().optional(),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
    taskBudgetTokens: z.number().int().min(20000).optional(),
    mcpServers: McpServersSchema.optional(),
    fileSimplifierEnabled: z.boolean().optional(),
  })
  .strict()

// Maps our unified McpServers map → the shape Anthropic Messages API expects
// in `mcp_servers[]`. Stdio entries are dropped (not supported remotely).
function toApiMcpServers(
  servers: McpServers | undefined,
): Array<Record<string, unknown>> | undefined {
  if (!servers) return undefined
  const out: Array<Record<string, unknown>> = []
  for (const [name, srv] of Object.entries(servers)) {
    if (!('url' in srv)) continue
    const entry: Record<string, unknown> = { name, type: 'url', url: srv.url }
    if (srv.authorizationToken) entry.authorization_token = srv.authorizationToken
    // NOTE: Anthropic's mcp_servers schema does not accept a `headers` field.
    // Auth must go via `authorization_token`. If the ia-flow config only carries
    // headers, extract a Bearer token so the API call still authenticates.
    else if (srv.headers?.Authorization?.startsWith('Bearer ')) {
      entry.authorization_token = srv.headers.Authorization.slice('Bearer '.length)
    }
    out.push(entry)
  }
  return out.length > 0 ? out : undefined
}

function parseAgentConfig(raw: unknown): z.infer<typeof AnthropicApiAgentConfigSchema> | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = AnthropicApiAgentConfigSchema.safeParse(raw)
  return r.success ? r.data : undefined
}

const log = createLogger('anthropic-api')

const API_URL = 'https://api.anthropic.com/v1/messages'

// Context dumps live outside the source tree so they don't pollute git.
// Defaults to $IA_FLOW_LOG_DIR/contexts, else $IA_FLOW_CONFIG_DIR/logs/contexts,
// else ~/.config/ia-flow/logs/contexts.
const HOME = Bun.env.HOME ?? ''
const CONFIG_DIR = Bun.env.IA_FLOW_CONFIG_DIR ?? join(HOME, '.config', 'ia-flow')
const BASE_LOG_DIR = Bun.env.IA_FLOW_LOG_DIR ?? join(CONFIG_DIR, 'logs')
const LOGS_DIR = join(BASE_LOG_DIR, 'contexts')

// Skip context dumps under `bun test` — the suite runs the provider many times
// with stubbed fetch, which would otherwise flood the log dir with junk files.
const IS_TEST = Bun.env.NODE_ENV === 'test'

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

async function logContext(
  runId: string,
  taskTitle: string,
  requestBody: object,
  responseText: string,
): Promise<void> {
  if (IS_TEST) return
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

export const anthropicApiProvider: IAgentProvider = {
  id: 'anthropic-api',
  kind: 'sync',
  name: 'Claude API (headless)',
  description:
    'Direct fetch to Anthropic API. Supports streaming + thinking. All config via providers.json.',

  async run(input: ProviderInput): Promise<ProviderOutput> {
    // Prefer the orchestrator-supplied runId so the execution_logs row and
    // all our log lines share the same correlation key. Falls back to a
    // local id only when called outside the orchestrator (tests).
    const runId = input.runId ?? randomUUID().slice(0, 8)
    const logCtx = {
      runId,
      agent: input.agentId,
      projectId: input.projectId,
      taskId: input.taskId,
      task: input.taskTitle,
    }

    const config = await loadProviderConfig()
    const { settings: cfg } = resolveStepSettings(input.step, config)
    const authHeader = buildAuthHeader()

    // Per-agent override — validated against this provider's private schema.
    const pc = parseAgentConfig(input.providerConfig)

    const resolvedModel = pc?.model ?? cfg.model
    const resolvedMaxTokens = pc?.maxTokens ?? cfg.maxTokens ?? 32000
    const resolvedEffort = pc?.effort ?? cfg.effort
    const resolvedTaskBudget = pc?.taskBudgetTokens ?? cfg.taskBudgetTokens

    const resolvedMcpServers = pc?.mcpServers ?? cfg.mcpServers
    const apiMcpServers = toApiMcpServers(resolvedMcpServers)

    const betaHeaders = new Set(cfg.anthropicBeta)
    if (resolvedTaskBudget != null) betaHeaders.add('task-budgets-2026-03-13')
    if (apiMcpServers) betaHeaders.add('mcp-client-2025-04-04')

    const agentBlocks = (input.systemPromptBlocks ?? []).map((block) => ({
      ...block,
      cache_control: { type: 'ephemeral' as const },
    }))

    const systemBlocks = [
      ...agentBlocks,
      ...cfg.systemPrompt.map((block) => ({
        ...block,
        cache_control: { type: 'ephemeral' as const },
      })),
    ]

    const headers = {
      'content-type': 'application/json',
      'anthropic-version': cfg.anthropicVersion,
      'anthropic-beta': [...betaHeaders].join(','),
      ...authHeader,
    }

    // Single-pass resolution: filter by kind ('sync' → drops async-only
    // tools), apply the per-agent allow-list (`input.tools`), and drop
    // opt-outs (`disabledTools`). Internal tools are always kept. See
    // `resolveTools` in ../../tools/index.ts.
    const toolDefs = resolveTools({
      disabledTools: input.disabledTools,
      providerKind: 'sync',
      toolNames: input.tools,
    }).map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }))

    const toolCtx: ToolContext = {
      repoPaths: input.repoPaths ?? {},
      sourceContext: input.sourceToolContext,
      fileSimplifierEnabled: pc?.fileSimplifierEnabled,
      // Absolute paths write/edit/exec tools are allowed to touch. Fed by the
      // WorkspaceManager (see #35) for implement-step runs; undefined means
      // "no writable zones" and write tools must refuse.
      writePaths: input.writePaths,
    }

    log.info(
      {
        event: 'agent.start',
        ...logCtx,
        model: resolvedModel,
        auth: authLabel(),
        tools: toolDefs.map((t) => t.name),
        repos: Object.keys(toolCtx.repoPaths),
        writePaths: toolCtx.writePaths ?? [],
        disabledTools: input.disabledTools ?? [],
        mcpServers: apiMcpServers ? apiMcpServers.map((s) => s.name) : [],
      },
      'Agent run started',
    )
    log.debug(
      { event: 'agent.prompt', ...logCtx, system: systemBlocks, userPrompt: input.prompt },
      'Initial request context',
    )

    let totalIters = 0
    let apiCallCount = 0

    const fetchApi = async (messages: any[]) => {
      apiCallCount++
      const iter = apiCallCount
      const body: Record<string, unknown> = {
        model: resolvedModel,
        max_tokens: resolvedMaxTokens,
        system: systemBlocks,
        messages,
      }
      if (toolDefs.length > 0) body.tools = toolDefs
      if (cfg.thinking) body.thinking = cfg.thinking
      if (apiMcpServers) body.mcp_servers = apiMcpServers

      const outputConfig: Record<string, unknown> = {}
      if (resolvedEffort) outputConfig.effort = resolvedEffort
      if (resolvedTaskBudget != null)
        outputConfig.task_budget = { type: 'tokens', total: resolvedTaskBudget }
      if (Object.keys(outputConfig).length > 0) body.output_config = outputConfig

      log.info(
        { event: 'api.request', ...logCtx, iter, messageCount: messages.length, body },
        'Anthropic request',
      )

      const t0 = Date.now()
      let res: Response
      try {
        res = await fetch(API_URL, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: input.signal,
        })
      } catch (err) {
        const ms = Date.now() - t0
        const errMsg = err instanceof Error ? err.message : String(err)
        const errName = err instanceof Error ? err.name : undefined
        // If the caller aborted us (polling divergence gate / shutdown),
        // rethrow untouched — the orchestrator classifies it via the shared
        // controller.signal. Anything else is an upstream failure: the socket
        // was reset, the streaming response stalled, or Bun's fetch timed out
        // on its own. Wrap with a clear message so the operator can tell it
        // apart from a real cancel in logs and in execution_logs.error_msg.
        if (input.signal?.aborted) throw err
        log.error(
          { event: 'api.abort', ...logCtx, iter, ms, errName, err: errMsg },
          'Anthropic fetch aborted upstream (network/stream stall)',
        )
        const wrapped = new Error(`Anthropic API upstream abort after ${ms}ms: ${errMsg}`, {
          cause: err,
        })
        wrapped.name = 'AbortError'
        throw wrapped
      }
      const ms = Date.now() - t0

      if (!res.ok) {
        const text = await res.text()
        log.error(
          { event: 'api.response', ...logCtx, iter, status: res.status, ms, body: text },
          'Anthropic error response',
        )
        throw new Error(`Anthropic API ${res.status}: ${text}`)
      }
      const json = await res.json()
      log.info(
        { event: 'api.response', ...logCtx, iter, status: res.status, ms, body: json },
        'Anthropic response',
      )
      return json
    }

    const {
      text: rawText,
      iters,
      stopReason,
      truncated,
    } = await executeLoop(fetchApi, [{ role: 'user', content: input.prompt }], toolCtx, {
      onToolCall: (name, inp, toolUseId) =>
        log.info({ event: 'tool.call', ...logCtx, tool: name, toolUseId, input: inp }, 'Tool call'),
      onToolResult: (name, result, toolUseId) =>
        log.info(
          {
            event: 'tool.result',
            ...logCtx,
            tool: name,
            toolUseId,
            result: result.slice(0, 500),
          },
          'Tool result',
        ),
      signal: input.signal,
      logContext: logCtx,
    })

    totalIters = iters
    log.info(
      { event: 'agent.complete', ...logCtx, iters, stopReason, truncated },
      truncated ? 'Agent run truncated' : 'Agent run complete',
    )

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
    return { content: cleaned, mode: 'api', truncated, stopReason }
  },
}
