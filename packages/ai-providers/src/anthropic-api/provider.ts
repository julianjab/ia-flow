import { randomUUID } from 'node:crypto'
// Anthropic API provider — direct fetch, agentic tool loop, config-driven
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type McpServers, McpServersSchema } from '@ia-flow/shared'
import { z } from 'zod'
import type {
  IAgentProvider,
  LoadProviderConfig,
  ProviderInput,
  ProviderOutput,
  ToolContext,
  ToolExecutionPort,
} from '../contract.js'
import { resolveStepSettings } from '../contract.js'
import { ANTHROPIC_API_URL as API_URL, buildAnthropicAuthHeader } from './auth.js'

/** Distinct error type for "the upstream provider stalled / reset / timed
 *  out on its own" — as opposed to "the operator (or the polling divergence
 *  gate) aborted us via AbortController". */
export class UpstreamAbortError extends Error {
  override name = 'UpstreamAbortError'
}

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

const buildAuthHeader = buildAnthropicAuthHeader

function authLabel(): string {
  if (Bun.env.CLAUDE_CODE_OAUTH_TOKEN) return 'CLAUDE_CODE_OAUTH_TOKEN'
  if (Bun.env.ANTHROPIC_API_KEY) return 'ANTHROPIC_API_KEY'
  return 'none'
}

export interface AnthropicApiProviderDeps {
  toolExecution: ToolExecutionPort
  loadProviderConfig: LoadProviderConfig
  /** Minimal logger, matching the shape of `createLogger('anthropic-api')`. */
  log: {
    info: (obj: object, msg?: string) => void
    debug: (obj: object, msg?: string) => void
    warn: (obj: object, msg?: string) => void
    error: (obj: object, msg?: string) => void
  }
  /** Directory context dumps are written to. Defaults to
   *  `$IA_FLOW_LOG_DIR/contexts`, else `$IA_FLOW_CONFIG_DIR/logs/contexts`,
   *  else `~/.config/ia-flow/logs/contexts` — same fallback chain as before
   *  the extraction, just resolved by the caller instead of read from env
   *  directly, so this package stays free of `IA_FLOW_*` env conventions. */
  contextLogDir?: string
  /** Skips context dumps — the caller (apps/server) sets this under `bun
   *  test` so the suite running the provider many times with stubbed fetch
   *  doesn't flood the log dir with junk files. */
  skipContextLog?: boolean
}

async function logContext(
  deps: AnthropicApiProviderDeps,
  runId: string,
  taskTitle: string,
  requestBody: object,
  responseText: string,
): Promise<void> {
  if (deps.skipContextLog) return
  const logsDir =
    deps.contextLogDir ?? join(Bun.env.HOME ?? '', '.config', 'ia-flow', 'logs', 'contexts')
  try {
    await mkdir(logsDir, { recursive: true })
    const slug = taskTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 40)
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const path = join(logsDir, `${ts}-${slug}.md`)
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
    deps.log.info({ event: 'agent.context_logged', runId, path }, 'Context logged')
  } catch (e) {
    deps.log.warn({ event: 'agent.context_log_failed', runId, err: e }, 'Failed to log context')
  }
}

export class AnthropicApiProvider implements IAgentProvider {
  readonly id = 'anthropic-api'
  readonly kind = 'sync' as const
  readonly name = 'Claude API (headless)'
  readonly description =
    'Direct fetch to Anthropic API. Supports streaming + thinking. All config via providers.json.'

  constructor(private readonly deps: AnthropicApiProviderDeps) {}

  async run(input: ProviderInput): Promise<ProviderOutput> {
    const { toolExecution, loadProviderConfig, log } = this.deps
    const deps = this.deps

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
    // tools), apply the per-agent allow-list, and drop opt-outs
    // (`disabledTools`). Internal tools are always kept.
    //
    // When the agent opted into the permission DSL (`policy` is set), its
    // `toolNames` set is the **authoritative** allow-list. `input.tools`
    // is deliberately ignored in that case — otherwise the union would let
    // a legacy `tools: ['write_file', 'run_command']` survive a switch to
    // `presetId: 'reader'`, silently keeping write + exec capabilities the
    // preset explicitly excludes.
    const effectiveToolNames = input.policy ? [...input.policy.toolNames] : input.tools
    const toolDefs = toolExecution.getToolDefinitions({
      disabledTools: input.disabledTools,
      providerKind: 'sync',
      toolNames: effectiveToolNames,
    })

    const toolCtx: ToolContext = {
      repoPaths: input.repoPaths ?? {},
      sourceContext: input.sourceToolContext,
      fileSimplifierEnabled: pc?.fileSimplifierEnabled,
      // Absolute paths write/edit/exec tools are allowed to touch. Fed by
      // the WorkspaceManager for implement-step runs; undefined means "no
      // writable zones" and write tools must refuse.
      writePaths: input.writePaths,
      // Propagate the task id so tools that need to identify the active
      // run without asking the agent (e.g. `workspace_reset` accepting an
      // empty `{}` input) can read it from the context.
      taskId: input.taskId,
      // Compiled permission policy. `bash_run` reads `policy.bash.bins` for
      // the whitelist and `policy.bash.git` for its safety rules. When
      // absent, the sandbox falls back to its legacy default policy.
      policy: input.policy,
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
        // rethrow untouched — the orchestrator classifies it via the
        // shared controller.signal. Anything else is an upstream failure.
        if (input.signal?.aborted) throw err
        log.error(
          { event: 'api.abort', ...logCtx, iter, ms, errName, err: errMsg },
          'Anthropic fetch aborted upstream (network/stream stall)',
        )
        throw new UpstreamAbortError(`Anthropic API upstream abort after ${ms}ms: ${errMsg}`, {
          cause: err,
        })
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
    } = await toolExecution.executeLoop(
      fetchApi,
      [{ role: 'user', content: input.prompt }],
      toolCtx,
      {
        onToolCall: (name, inp, toolUseId) =>
          log.info(
            { event: 'tool.call', ...logCtx, tool: name, toolUseId, input: inp },
            'Tool call',
          ),
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
      },
    )

    log.info(
      { event: 'agent.complete', ...logCtx, iters, stopReason, truncated },
      truncated ? 'Agent run truncated' : 'Agent run complete',
    )

    await logContext(
      deps,
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
  }
}
