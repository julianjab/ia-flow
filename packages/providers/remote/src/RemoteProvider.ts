import { randomUUID } from 'node:crypto'
import {
  type Admission,
  Condition,
  type McpServerRef,
  type PipelineExecutionContext,
  type Provider,
  type ProviderRunContext,
  type ProviderRunOutput,
  type Tool,
} from '@ia-flow/agent-engine'
import { runParent } from '@ia-flow/provider-shared'
import { createLogger, exportTraceContext } from '@ia-flow/telemetry'
import {
  type HostTask,
  PROTOCOL_PREFIX,
  type RunResult,
  type ToolSpec,
  type WorkspaceToolSpec,
} from './protocol.js'
import { providerId } from './providerId.js'
import type { RemoteHub } from './RemoteHub.js'
import { RemoteRun } from './RemoteRun.js'

export interface RemoteProviderOptions {
  hub: RemoteHub
  /** El nombre con el que se suscribió el host. */
  host: string
}

/** Cuánto espera el runner si el host está lleno o se fue, antes de volver a preguntar. */
const BUSY_RETRY_MS = 10_000
/** El tope de una corrida si su `providerConfig` no trae `timeoutMinutes`. */
const DEFAULT_TIMEOUT_MINUTES = 120
/** Lo que se le suma al tope: que el corte del provider del host llegue antes que el del runner. */
const TIMEOUT_GRACE_MINUTES = 2

/**
 * Un host suscrito, como provider: `remote:<name>`. No conduce nada: le entrega la corrida al
 * host, que la corre con SU provider (el de su runner.yaml) sobre su worktree, y espera lo que
 * devuelve. Del `ProviderRunContext` del agente viaja todo lo que es JSON; las tools se parten en
 * dos — las de workspace (`fs_*`, `bash_run`) van como `origin` y el host las rearma allá, las del
 * engine se quedan acá y el host las llama por `/tools`.
 *
 * Recibe todas las tools (`workspace: 'runner'`): las de workspace no se corren acá, pero hace
 * falta verlas para mandar su `origin`. El host decide si su provider las usa (la Messages API) o
 * trae las suyas (el CLI).
 */
export class RemoteProvider implements Provider {
  readonly id: string
  readonly workspace = 'runner' as const
  readonly log = createLogger('provider-remote')

  constructor(private readonly options: RemoteProviderOptions) {
    this.id = providerId(options.host)
  }

  /**
   * Lo decide el runner, con lo que el host declaró al suscribirse: su tope y sus condiciones —
   * las del `when` de las pipelines, sobre el payload del evento más `agentId` y `eventType`. Sin
   * ir y volver al host.
   */
  async canAccept(request: { agentId: string; ctx: PipelineExecutionContext }): Promise<Admission> {
    const host = this.options.hub.host(this.options.host)
    if (!host) {
      return { accept: false, reason: `${this.id} no está suscrito`, retryAfterMs: BUSY_RETRY_MS }
    }
    const { maxConcurrent } = host.subscription
    if (host.runs.size >= maxConcurrent) {
      return {
        accept: false,
        reason: `${this.id} al tope (${host.runs.size}/${maxConcurrent})`,
        retryAfterMs: BUSY_RETRY_MS,
      }
    }
    const subject = subjectOf(request.agentId, request.ctx)
    if (Condition.evaluateAll(host.conditions, subject)) return { accept: true }
    const failed = host.conditions.filter((condition) => !condition.evaluate(subject))
    return {
      accept: false,
      reason: `${this.id} no toma esto: ${failed.map((condition) => condition.describe(subject)).join('; ')}`,
      retryAfterMs: BUSY_RETRY_MS,
    }
  }

  async run(ctx: ProviderRunContext): Promise<ProviderRunOutput> {
    const { engine, workspace, skipped } = splitTools(ctx.tools)
    for (const name of skipped) {
      this.log.warn(
        `${ctx.agentId}: la tool de workspace ${name} no dice con qué se armó: no viaja`,
      )
    }
    const run = new RemoteRun({
      agentId: ctx.agentId,
      tools: engine,
      parent: runParent(ctx),
      ...(ctx.inbox ? { inbox: ctx.inbox } : {}),
      ...(ctx.saveConversation ? { saveConversation: ctx.saveConversation } : {}),
      ...(ctx.onText ? { onText: ctx.onText } : {}),
    })
    const base = `${PROTOCOL_PREFIX}/runs/${run.token}`
    const task: HostTask = {
      runId: randomUUID(),
      agentId: ctx.agentId,
      prompt: ctx.prompt,
      systemPrompts: ctx.systemPrompts,
      variables: ctx.variables,
      mcpServers: await resolveMcpServers(ctx.mcpServers),
      providerConfig: ctx.providerConfig,
      tools: engine.map(toSpec),
      workspaceTools: workspace,
      ...(ctx.resume ? { resume: ctx.resume } : {}),
      event: {
        id: ctx.ctx.event.id,
        type: ctx.ctx.event.type,
        payload: ctx.ctx.event.payload,
        ...(ctx.ctx.event.scope ? { scope: ctx.ctx.event.scope } : {}),
        occurredAt: ctx.ctx.event.occurredAt,
      },
      ...(ctx.ctx.lane ? { lane: ctx.ctx.lane } : {}),
      endpoints: {
        tools: `${base}/tools`,
        inbox: `${base}/inbox`,
        conversation: `${base}/conversation`,
        text: `${base}/text`,
        result: `${base}/result`,
      },
    }
    const trace = exportTraceContext()
    if (trace) task.trace = trace
    const minutes =
      numberOr(ctx.providerConfig.timeoutMinutes, DEFAULT_TIMEOUT_MINUTES) + TIMEOUT_GRACE_MINUTES
    this.log.info(`${ctx.agentId}: corrida ${task.runId} a ${this.id}`)
    const end = await this.options.hub.dispatch(this.options.host, task, run, minutes)
    if (end.kind === 'result') return outputOf(this.id, end.result)
    if (end.kind === 'timeout') {
      return { outcome: 'error', summary: `${this.id}: la corrida superó ${end.minutes} min` }
    }
    return { outcome: 'error', summary: end.reason }
  }
}

/** Las del engine (se corren acá) y las de workspace (viajan para rearmarse en el host). Una de
 *  workspace sin `origin` no se puede rearmar: no viaja. */
function splitTools(tools: Tool[]): {
  engine: Tool[]
  workspace: WorkspaceToolSpec[]
  skipped: string[]
} {
  const engine: Tool[] = []
  const workspace: WorkspaceToolSpec[] = []
  const skipped: string[] = []
  for (const tool of tools) {
    if (!tool.workspace) engine.push(tool)
    else if (tool.origin) workspace.push({ name: tool.name, origin: tool.origin })
    else skipped.push(tool.name)
  }
  return { engine, workspace, skipped }
}

function toSpec(tool: Tool): ToolSpec {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.terminal ? { terminal: true } : {}),
    ...(tool.failure ? { failure: true } : {}),
  }
}

function outputOf(id: string, result: RunResult): ProviderRunOutput {
  if (result.status === 'failed') {
    return { outcome: 'error', summary: `${id} no pudo correrla: ${result.message}` }
  }
  return result.output
}

/** Contra qué se evalúan las condiciones del host: el payload del evento, más quién y qué. */
function subjectOf(agentId: string, ctx: PipelineExecutionContext): Record<string, unknown> {
  const payload = ctx.event.payload
  const base = typeof payload === 'object' && payload !== null ? payload : {}
  return { ...base, agentId, eventType: ctx.event.type, scope: ctx.event.scope ?? {} }
}

/** Los MCP externos del agente como viajan: con la credencial ya resuelta (un token puede ser
 *  una función que refresca) y sin nada que no sea JSON. */
async function resolveMcpServers(servers: McpServerRef[]): Promise<HostTask['mcpServers']> {
  return Promise.all(
    servers.map(async ({ id, config }) => {
      const raw = config.authorizationToken
      const token = typeof raw === 'function' ? await (raw as () => unknown)() : raw
      const plain = Object.fromEntries(
        Object.entries(config).filter(([, value]) => typeof value !== 'function'),
      )
      return { id, config: token === undefined ? plain : { ...plain, authorizationToken: token } }
    }),
  )
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}
