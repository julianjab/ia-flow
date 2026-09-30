import { randomUUID } from 'node:crypto'
import {
  type Admission,
  Condition,
  type McpServerRef,
  type PipelineExecutionContext,
  type Provider,
  type ProviderRunContext,
  type ProviderRunOutput,
} from '@ia-flow/agent-engine'
import {
  type CliConversation,
  cliSessionOf,
  exitsOf,
  labelOf,
  RunChannel,
  runParent,
  turnPrompt,
} from '@ia-flow/provider-shared'
import { createLogger } from '@ia-flow/telemetry'
import { type HostTask, PROTOCOL_PREFIX } from './protocol.js'
import { providerId, type RemoteHub } from './RemoteHub.js'

export interface RemoteProviderOptions {
  hub: RemoteHub
  /** El nombre con el que se suscribió el host. */
  host: string
}

/** Cuánto espera el runner si el host está lleno o se fue, antes de volver a preguntar. */
const BUSY_RETRY_MS = 10_000
const DEFAULT_TIMEOUT_MINUTES = 120
/** Lo que se le suma al tope del host: que su propio corte llegue antes que el del runner. */
const TIMEOUT_GRACE_MINUTES = 2
const DEFAULT_STOP_NUDGES = 2

/**
 * Un host suscrito, como provider: `remote:<name>`. Para el engine es uno más, con workspace
 * nativo (el host trabaja SU worktree con las tools de su CLI, así que las tools de workspace del
 * agente no le llegan). `run` no conduce nada: abre el canal de la corrida en la API del runner,
 * le entrega la tarea al host, y espera a que el modelo — allá — cierre el turno llamando una tool
 * terminal por el MCP de acá.
 */
export class RemoteProvider implements Provider {
  readonly id: string
  readonly workspace = 'native' as const
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
    const config = ctx.providerConfig
    const resumedSession = cliSessionOf(ctx.resume?.conversation)
    const sessionId = resumedSession ?? randomUUID()
    const conversation: CliConversation = { sessionId }
    // Desde ya: si el runner muere a mitad de la corrida, se retoma esta sesión.
    ctx.saveConversation?.(conversation)

    const channel = new RunChannel({
      agentId: ctx.agentId,
      tools: ctx.tools,
      ...(ctx.inbox ? { inbox: ctx.inbox } : {}),
      parent: runParent(ctx),
      maxStopNudges: numberOr(config.maxStopNudges, DEFAULT_STOP_NUDGES),
      ...(ctx.onText ? { onText: ctx.onText } : {}),
      since: new Date(),
      // La sesión escribe su transcripción en el disco del host: es éste quien la lee y la manda
      // por `/transcript` (el uso de cada request).
      transcript: false,
    })
    const base = `${PROTOCOL_PREFIX}/runs/${channel.token}`
    const task: HostTask = {
      runId: randomUUID(),
      agentId: ctx.agentId,
      label: labelOf(ctx),
      prompt: turnPrompt(ctx, resumedSession !== undefined),
      systemPrompts: ctx.systemPrompts,
      exits: exitsOf(ctx),
      mcpServers: await resolveMcpServers(ctx.mcpServers),
      providerConfig: config,
      event: {
        id: ctx.ctx.event.id,
        type: ctx.ctx.event.type,
        payload: ctx.ctx.event.payload,
        ...(ctx.ctx.event.scope ? { scope: ctx.ctx.event.scope } : {}),
        occurredAt: ctx.ctx.event.occurredAt,
      },
      session: { id: sessionId, resume: resumedSession !== undefined },
      endpoints: {
        mcp: `${base}/mcp`,
        hooks: `${base}/hooks`,
        transcript: `${base}/transcript`,
        report: `${base}/report`,
      },
    }
    const minutes = numberOr(config.timeoutMinutes, DEFAULT_TIMEOUT_MINUTES) + TIMEOUT_GRACE_MINUTES
    this.log.info(`${ctx.agentId}: corrida ${task.runId} a ${this.id}`)
    try {
      const end = await this.options.hub.dispatch(this.options.host, task, channel, minutes)
      // Un reporte que llega justo después de cerrar el turno cuenta como cerrado.
      if (end.kind === 'done' || channel.finished) return { outcome: 'success', conversation }
      if (end.kind === 'timeout') {
        return { outcome: 'error', summary: `${this.id}: la corrida superó ${end.minutes} min` }
      }
      if (end.kind === 'lost') return { outcome: 'error', summary: end.reason }
      const { report } = end
      return {
        outcome: 'error',
        summary:
          report.status === 'failed'
            ? `${this.id} no pudo correrla: ${report.message ?? 'sin detalle'}`
            : `la sesión en ${this.id} terminó sin cerrar el turno (código ${report.code ?? '?'})${report.message ? `: ${report.message}` : ''}`,
      }
    } finally {
      await channel.close().catch(() => {})
    }
  }
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
