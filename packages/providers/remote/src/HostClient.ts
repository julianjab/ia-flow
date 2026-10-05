import type { RunEnding } from '@ia-flow/provider-shared'
import { createLogger, withRemoteTraceContext, withSpan } from '@ia-flow/telemetry'
import {
  type AcceptRow,
  type HostTask,
  PollResponse,
  PROTOCOL_PREFIX,
  type RunReport,
  SubscribeResponse,
} from './protocol.js'

/** Lo que hace el host con una tarea: lanza la sesión y termina cuando ésta termina, o cuando
 *  `signal` se aborta (el runner ya cerró la corrida). */
/** El `reason` del abort cuando el runner cerró la corrida sin decir cómo (un runner viejo). */
export const CLOSED_WITHOUT_ENDING = 'closed'

/** Cómo cerró el modelo una corrida que el runner cerró, leído del `reason` de su signal. */
export function endingOfSignal(signal: AbortSignal): RunEnding | undefined {
  const reason = signal.reason
  return reason === 'done' || reason === 'paused' || reason === 'failed' ? reason : undefined
}

export type TaskRunner = (
  task: HostTask,
  runner: { base: string },
  signal: AbortSignal,
) => Promise<RunReport | undefined>

export interface HostClientOptions {
  /** La base del runner (`https://ia-flow.example.com`), sin `/v1`. */
  runnerUrl: string
  /** El bearer de hosts del runner. */
  token: string
  name: string
  maxConcurrent: number
  accepts: AcceptRow[]
  run: TaskRunner
  fetchImpl?: typeof fetch
  /** Cuánto espera antes de reintentar con el runner caído. Default: 5 s. */
  retryMs?: number
}

/**
 * Del lado del host: se suscribe al runner y le pide tareas por long-poll — todas las conexiones
 * salen de acá, así que el host no necesita URL pública. Cada tarea la corre `run` (el runner-v2
 * lanza ahí un `claude` apuntando al canal de la corrida en el runner) y, cuando la sesión termina,
 * se lo reporta. Las corridas que el runner cierra (el modelo ya eligió su salida) le llegan en el
 * poll y se cortan. Si el runner no lo conoce más (se reinició), se vuelve a suscribir solo.
 */
export class HostClient {
  readonly log = createLogger('provider-remote.host')
  private readonly base: string
  private readonly fetchImpl: typeof fetch
  private readonly active = new Map<string, AbortController>()
  private session: string | undefined
  private stopped = false
  private loop: Promise<void> | undefined

  constructor(private readonly options: HostClientOptions) {
    this.base = options.runnerUrl.replace(/\/+$/, '')
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  /** Las corridas en curso acá. */
  get running(): string[] {
    return [...this.active.keys()]
  }

  start(): void {
    this.loop ??= this.run()
  }

  /** Deja de pedir tareas y corta las sesiones en curso. */
  async stop(): Promise<void> {
    this.stopped = true
    for (const controller of this.active.values()) controller.abort()
    await this.loop?.catch(() => {})
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      try {
        this.session ??= await this.subscribe()
        const reply = await this.poll(this.session)
        if (reply === 'unknown') {
          this.log.warn('el runner no reconoce la sesión: vuelvo a suscribirme')
          this.session = undefined
          continue
        }
        // El `reason` del abort es cómo cerró el modelo (`RunEnding`), si el runner lo dice: con
        // eso el `TaskRunner` decide qué hace con su worktree.
        for (const runId of reply.closed) {
          this.active.get(runId)?.abort(reply.endings?.[runId] ?? CLOSED_WITHOUT_ENDING)
        }
        for (const task of reply.tasks) this.take(task)
      } catch (error) {
        if (this.stopped) return
        this.log.warn(`runner ${this.base} inalcanzable: ${(error as Error).message}`)
        await delay(this.options.retryMs ?? 5_000)
      }
    }
  }

  private async subscribe(): Promise<string> {
    const res = await this.post('/hosts/subscribe', {
      name: this.options.name,
      maxConcurrent: this.options.maxConcurrent,
      accepts: this.options.accepts,
    })
    if (!res.ok) throw new Error(`suscripción rechazada: HTTP ${res.status} ${await res.text()}`)
    const { session, provider, leaseMs } = SubscribeResponse.parse(await res.json())
    this.log.info(`suscrito a ${this.base} como ${provider} (lease ${leaseMs} ms)`)
    return session
  }

  private async poll(session: string): Promise<PollResponse | 'unknown'> {
    const res = await this.post(`/hosts/${encodeURIComponent(session)}/poll`, {
      running: this.running,
    })
    if (res.status === 404) return 'unknown'
    if (!res.ok) throw new Error(`poll: HTTP ${res.status} ${await res.text()}`)
    return PollResponse.parse(await res.json())
  }

  private take(task: HostTask): void {
    if (this.active.has(task.runId)) return
    const controller = new AbortController()
    this.active.set(task.runId, controller)
    // Todo lo de la corrida cuelga del span del agente en el runner, con sus atributos: los logs y
    // spans del host se ven en la misma traza y en la misma ejecución que los del runner.
    void withRemoteTraceContext(task.trace, async () => {
      this.log.info(`${task.agentId}: corrida ${task.runId} (${task.label})`)
      let report: RunReport | undefined
      try {
        report = await withSpan(
          `host.run ${task.agentId}`,
          { 'ia.host.name': this.options.name, 'ia.host.run_id': task.runId },
          () => this.options.run(task, { base: this.base }, controller.signal),
        )
      } catch (error) {
        report = { status: 'failed', message: (error as Error).message }
      } finally {
        this.active.delete(task.runId)
      }
      // Cortada por el runner: ya sabe cómo terminó.
      if (report && !controller.signal.aborted) await this.report(task, report)
    })
  }

  private async report(task: HostTask, report: RunReport): Promise<void> {
    try {
      await this.fetchImpl(`${this.base}${task.endpoints.report}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(report),
      })
    } catch (error) {
      this.log.warn(`no pude reportar la corrida ${task.runId}: ${(error as Error).message}`)
    }
  }

  private post(path: string, body: unknown): Promise<Response> {
    return this.fetchImpl(`${this.base}${PROTOCOL_PREFIX}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.options.token}`,
      },
      body: JSON.stringify(body),
    })
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
