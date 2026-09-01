// Thin wrappers around IExecutionLogRepository writes. The repo is optional
// (tests build the orchestrator without one) and every call site already
// swallowed insert/update failures with the same log.warn — consolidated
// here so AgentOrchestrator's per-agent lifecycle doesn't repeat the
// try/catch ten times over.
import { createHash } from 'node:crypto'
import type { RunMetrics } from '@ia-flow/ai-providers'
import type { ExecutionLog } from '@ia-flow/shared'
import type { IExecutionLogRepository } from './contract.js'
import { classifyFailure } from './failure-taxonomy.js'
import { createLogger } from './logger.js'
import { takeRunTelemetry } from './run-telemetry.js'

const log = createLogger('execution-log')

export function safeInsertLog(
  repo: IExecutionLogRepository | undefined,
  entry: ExecutionLog,
): void {
  try {
    repo?.insert(entry)
  } catch (err) {
    log.warn({ err }, 'Failed to insert execution log')
  }
}

export function safeUpdateLog(
  repo: IExecutionLogRepository | undefined,
  id: string,
  patch: Partial<ExecutionLog>,
): void {
  try {
    repo?.update(id, patch)
  } catch (err) {
    log.warn({ err }, 'Failed to update execution log')
  }
}

/**
 * Identity of the prompt a run actually executed — the resolved prompt plus
 * the system blocks, hashed together.
 *
 * Truncated to 12 hex chars: this is a grouping key for a few thousand rows,
 * not a security primitive, and a short one stays readable in the UI.
 */
export function hashPrompt(...parts: Array<string | undefined | null>): string {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(part ?? '')
  return hash.digest('hex').slice(0, 12)
}

/**
 * Serializa con las claves de cada objeto ORDENADAS, recursivamente.
 *
 * `JSON.stringify` conserva el orden de inserción, así que el mismo agente
 * leído por dos caminos distintos (una fila de SQLite, un YAML de deploy, un
 * PUT de la web) puede producir dos strings distintos para la MISMA config —
 * y con eso, dos hashes. Sin esto el hash mediría cómo se construyó el objeto
 * en memoria, no qué dice.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

/** La parte de un agente que define su COMPORTAMIENTO, para `hashAgentConfig`. */
export interface AgentConfigIdentity {
  /** El template CRUDO (`agentDef.prompt`), con los `{{...}}` sin resolver. */
  prompt: string
  /** Bloques ya resueltos: editar el texto de un system prompt COMPARTIDO
   *  cambia el comportamiento tanto como editar el prompt propio, y por id
   *  ese cambio sería invisible. */
  systemPromptBlocks?: unknown
  tools?: unknown
  variables?: unknown
  provider?: unknown
  providerConfig?: unknown
  saveOutput?: unknown
  /** Los outputFields del agente: cambian lo que produce, no sólo cómo. */
  output?: unknown
  exits?: unknown
}

/**
 * Identidad de la CONFIGURACIÓN de un agente — estable mientras nadie lo
 * edite, y por eso lo que hace comparables dos runs entre sí.
 *
 * La distinción con `hashPrompt` es la que hace útil a `promptVersions`: el
 * prompt que un run ejecuta lleva las variables ya sustituidas (el título del
 * issue, sus comentarios, el branch de la task), así que hashearlo daba un
 * valor distinto POR RUN — 34 runs de `implementer` producían 32 hashes, y
 * "el prompt cambió 32 veces" era ruido, no una señal de regresión.
 *
 * Entra todo lo que cambia lo que el agente HACE (prompt, system, tools,
 * provider, salidas). Queda afuera lo organizativo — `position`, `projectId`,
 * `id` —: mover un agente de lugar no invalida la comparación de sus runs.
 */
export function hashAgentConfig(identity: AgentConfigIdentity): string {
  return hashPrompt(canonicalJson(identity))
}

export interface FinishPatchInput {
  outcome: NonNullable<ExecutionLog['outcome']>
  stopReason?: string | null
  errorMsg?: string | null
  /** Wall-clock start, from `Date.now()` at dispatch. */
  startedAtMs: number
  /** Correlates with daemon.log and /api/hook-events. Also the key the hook
   *  tally is read back under for async runs. */
  runId: string
  /** Set by sync providers (`anthropic-api`). Undefined for async/terminal
   *  runs, whose counters come from the hook tally instead — and whose token
   *  usage is simply not observable from this process. */
  metrics?: RunMetrics
  /** How many tools the agent was configured with — lets `classifyFailure`
   *  tell "did nothing" from "had nothing to do". */
  toolsAvailable?: number
  agentPromptHash?: string
  /** `hashSystemPrompt` de los bloques resueltos — ver el schema del log. */
  systemPromptHash?: string
}

/**
 * Hash de SÓLO los system prompts resueltos. `hashAgentConfig` ya los
 * incluye, pero mezclados con el resto: cuando cambia, no dice si lo que se
 * editó fue el agente o un system prompt compartido. Con este segundo hash la
 * pregunta se contesta cruzándolos en el detalle del agente.
 */
export function hashSystemPrompt(systemPromptBlocks: unknown): string {
  return hashPrompt(canonicalJson(systemPromptBlocks ?? []))
}

/**
 * Builds the telemetry half of a finishing execution-log update. Kept here
 * rather than inlined at each of Agent.ts's several finish branches so every
 * one of them records the same fields — a branch that forgets a column is a
 * silent hole in the metric, and the branches that finish a run are exactly
 * the interesting ones (truncated, cancelled, errored).
 */
export function buildFinishPatch(input: FinishPatchInput): Partial<ExecutionLog> {
  // Sync providers measured everything themselves. For async runs the only
  // observer was the Claude Code hook forwarder: it counts tool calls, and —
  // cuando el hook mandó el path de la transcripción y el daemon tiene un
  // lector cableado— también trae el usage y el modelo de la sesión. Lo que
  // no se pudo observar queda null: "not measurable here", not zero.
  const hookTally = input.metrics ? undefined : takeRunTelemetry(input.runId)
  const toolCalls = input.metrics?.toolCalls ?? hookTally?.toolCalls ?? null
  const toolErrors = input.metrics?.toolErrors ?? hookTally?.toolErrors ?? null
  const usage = input.metrics?.usage ?? hookTally?.usage
  const toolBreakdown = input.metrics?.toolBreakdown ?? hookTally?.toolBreakdown
  const hasBreakdown = toolBreakdown !== undefined && Object.keys(toolBreakdown).length > 0

  return {
    durationMs: Date.now() - input.startedAtMs,
    runId: input.runId,
    agentPromptHash: input.agentPromptHash ?? null,
    systemPromptHash: input.systemPromptHash ?? null,
    model: input.metrics?.model ?? hookTally?.model ?? null,
    tokensIn: usage?.inputTokens ?? null,
    tokensOut: usage?.outputTokens ?? null,
    cacheReadTokens: usage?.cacheReadTokens ?? null,
    cacheCreationTokens: usage?.cacheCreationTokens ?? null,
    iters: input.metrics?.iters ?? null,
    toolCalls,
    toolErrors,
    toolBreakdown: hasBreakdown ? toolBreakdown : null,
    failureClass: classifyFailure({
      outcome: input.outcome,
      stopReason: input.stopReason,
      errorMsg: input.errorMsg,
      toolCalls,
      toolErrors,
      toolsAvailable: input.toolsAvailable,
    }),
  }
}
