import { createLogger } from '@ia-flow/telemetry'
import type { DomainEvent } from '../events/DomainEvent.js'
import { Pause, type PauseJSON, TIMEOUT_BRANCH } from '../pipeline/actions/Pause.js'
import type { Checkpoint } from '../pipeline/Pipeline.js'
import type { Interruption, Runnable } from '../pipeline/Runnable.js'
import { Inbox } from './Inbox.js'

/**
 * Una ejecución: UNA corrida de una pipeline con agentes sobre UNA task (la `key`, que el `Engine`
 * saca del evento). Es lo que le permite al engine contestar "¿ya hay algo corriendo para esta
 * task?" y, si lo hay, ofrecerle el evento a su paso activo antes de arrancar otra corrida.
 *
 * Lo que llega mientras corre va a su `Inbox`: un agente en su loop con el modelo lo vacía antes de
 * cada vuelta (`ProviderRunContext.inbox`); lo que nadie alcanzó a leer queda en `takeUnread()` y el
 * engine lo vuelve a despachar al cerrar la ejecución, así que nunca se pierde.
 *
 * Una ejecución también puede PAUSARSE (una `PauseAction` de su pipeline): libera su lugar y su
 * task, guarda por dónde seguir (`Checkpoint`) y espera un evento que la despierte (`wake`) o
 * que venza (`expired`). Si mientras tanto arranca otra corrida de agentes sobre la task, la
 * pausa queda reemplazada (`superseded`): esa corrida lee el estado nuevo.
 *
 * Cada cambio de estado y cada evento entregado se anotan en su `ExecutionJournal` (el
 * repositorio del store): así un store persistente la recupera tras un reinicio.
 */
export type ExecutionStatus = 'running' | 'paused' | 'done' | 'failed' | 'superseded'
export type ClosedStatus = Exclude<ExecutionStatus, 'running' | 'paused'>

/** Por qué despertó una pausa: la rama y por dónde seguir. */
export interface Wake {
  branch: string
  checkpoint: Checkpoint
}

/** Una ejecución como datos — lo que guarda un repositorio. */
export interface ExecutionRecord {
  id: string
  key: string
  pipelineId: string
  status: ExecutionStatus
  startedAt: string
  waitedMs: number
  closedAt?: string
  /** Por qué cerró, si no fue por su propia corrida (ej. `interrupted` tras un reinicio). */
  closeReason?: string
  /** Con qué se despierta, mientras está pausada. */
  pause?: PauseJSON
  /** Por dónde sigue: mientras está pausada, desde su pausa; mientras corre, desde el paso que
   *  guarda su progreso (`progress`), si alguno — con eso se retoma tras un reinicio. */
  checkpoint?: Checkpoint
}

type PausedRecord = ExecutionRecord & Required<Pick<ExecutionRecord, 'pause' | 'checkpoint'>>

/** Dónde anota una ejecución lo que le pasa. */
export interface ExecutionJournal {
  /** Su estado nuevo: abrió, se pausó, despertó o cerró. */
  save(record: ExecutionRecord): void
  /** Su paso activo aceptó `event`. */
  delivered(executionId: string, event: DomainEvent<any>): void
  /** Todo lo que se le entregó quedó leído (o se tomó para re-despacharlo). */
  read(executionId: string): void
}

export interface ExecutionProps {
  id: string
  key: string
  pipelineId: string
  /** Cuándo se pidió (`Date.now()` del `start`); default: ahora, sin espera. */
  queuedAt?: number
  journal?: ExecutionJournal
}

export class Execution {
  readonly log = createLogger('agent-engine.execution')
  readonly id: string
  readonly key: string
  readonly pipelineId: string
  private readonly startedMs: number
  readonly startedAt: string
  /** Cuánto esperó turno (su task ocupada) o lugar bajo el tope antes de arrancar. */
  readonly waitedMs: number
  status: ExecutionStatus = 'running'
  private readonly inbox = new Inbox()
  private readonly journal?: ExecutionJournal
  private step: Runnable | undefined
  private interrupted: Interruption | undefined
  private paused: { pause: Pause; checkpoint: Checkpoint } | undefined
  /** Por dónde va el paso activo mientras corre (ver `progress`). */
  private progressed: Checkpoint | undefined
  private closedAt?: string
  private closeReason?: string
  /** Devuelve su lugar y su task al store — lo pone el store cada vez que se los da. */
  private releaser: (() => void) | undefined
  private settle!: () => void
  /** Resuelve cuando la ejecución termina, bien o mal — nunca rechaza. Una pausa no la termina. */
  readonly finished = new Promise<void>((resolve) => {
    this.settle = resolve
  })

  /** `restored`: la ejecución pausada que se guardó — ver `Execution.restore`. */
  private constructor(props: ExecutionProps, restored?: PausedRecord) {
    this.id = props.id
    this.key = props.key
    this.pipelineId = props.pipelineId
    this.journal = props.journal
    if (restored) {
      this.startedMs = Date.parse(restored.startedAt)
      this.startedAt = restored.startedAt
      this.waitedMs = restored.waitedMs
      this.status = 'paused'
      this.paused = { pause: Pause.fromJSON(restored.pause), checkpoint: restored.checkpoint }
      return
    }
    this.startedMs = Date.now()
    this.startedAt = new Date(this.startedMs).toISOString()
    this.waitedMs = Math.max(0, this.startedMs - (props.queuedAt ?? this.startedMs))
    this.journal?.save(this.toRecord())
  }

  /** Abre una ejecución nueva, `running`. */
  static open(props: ExecutionProps): Execution {
    return new Execution(props)
  }

  /** Vuelve a levantar una ejecución PAUSADA que se guardó (ej. antes de un reinicio). */
  static restore(record: ExecutionRecord, journal?: ExecutionJournal): Execution {
    if (record.status !== 'paused' || !record.pause || !record.checkpoint) {
      throw new Error(`${record.id}: sólo se restaura una ejecución pausada (es ${record.status})`)
    }
    return new Execution(
      { id: record.id, key: record.key, pipelineId: record.pipelineId, journal },
      record as PausedRecord,
    )
  }

  /** El paso que está AHORA en su loop con el modelo — el único que puede leer el inbox. Entre
   *  pasos, o antes/después de un agente, no hay ninguno. */
  get active(): Runnable | undefined {
    return this.step
  }

  /** Si la interrumpieron (ver `interrupt`). */
  get interruption(): Interruption | undefined {
    return this.interrupted
  }

  /** La pausa en la que está, si está pausada. */
  get pausedOn(): Pause | undefined {
    return this.status === 'paused' ? this.paused?.pause : undefined
  }

  /** Lo llama el agente al entrar y salir de su loop con el provider. */
  enter(step: Runnable): void {
    this.step = step
  }

  leave(): void {
    this.step = undefined
  }

  /** Si `event` nació adentro de esta ejecución (lo emitió un paso suyo): no tiene que esperarla,
   *  sería esperarse a sí misma. */
  owns(event: DomainEvent<any>): boolean {
    return event.executionId === this.id
  }

  /**
   * Le ofrece `event` al paso activo: si lo acepta (`Runnable.accepts`), `message` le llega en su
   * próxima vuelta y devuelve `true`. Si no hay paso activo o no lo acepta, `false` — el evento
   * sigue su camino por las reglas, y queda recordado por si su pausa lo espera.
   */
  inject(message: string, event: DomainEvent<any>): boolean {
    if (this.status !== 'running') return false
    if (!this.step?.accepts(event)) {
      this.inbox.miss(event)
      return false
    }
    this.inbox.deliver(message, event)
    this.journal?.delivered(this.id, event)
    return true
  }

  /**
   * Le avisa a su agente activo que viene otra corrida sobre la task (`message`, en su próxima
   * vuelta) y la marca interrumpida: cuando ese agente termina, la pipeline no sigue sus salidas
   * ni el resto de `do[]` — corre su `onInterrupt` y la ejecución cierra `superseded`. Sólo con
   * un AGENTE en su loop: entre pasos, o en una acción (ej. la ruta que mueve la tarjeta), no hay
   * quién decida parar, y cortar ahí dejaría la salida a medio aplicar. Una sola vez.
   */
  interrupt(interruption: Interruption, message: string): boolean {
    if (this.status !== 'running' || this.interrupted) return false
    if (this.step?.kind !== 'agent') return false
    this.interrupted = interruption
    this.inbox.notify(message)
    this.log.info(`${this.id} se interrumpe: ${interruption.reason}`, {
      'ia.execution.id': this.id,
      'ia.pipeline.id': interruption.by,
    })
    return true
  }

  /** Si se pausó, el primer evento que llegó mientras corría (sin que ningún paso lo aceptara) y
   *  despierta su pausa. Vacía lo recordado: se toma una sola vez. */
  takeMissedWake(): DomainEvent<any> | undefined {
    const missed = this.inbox.takeMissed()
    const pause = this.pausedOn
    return pause ? missed.find((event) => pause.match(event) !== undefined) : undefined
  }

  /** Lo que llegó desde la última vez, en orden — y lo marca leído. */
  drain(): string[] {
    return this.markRead(this.inbox.drain())
  }

  /** Los eventos inyectados que ningún agente leyó — y los consume: se toman una sola vez, así
   *  que una ejecución que se pausa y después cierra no los devuelve dos veces. */
  takeUnread(): DomainEvent<any>[] {
    return this.markRead(this.inbox.takeUnread())
  }

  /** Por dónde va el paso activo (o `undefined`: terminó). Se anota en el journal: si el proceso
   *  muere, el store la retoma desde ahí en vez de darla por perdida. */
  progress(checkpoint: Checkpoint | undefined): void {
    if (this.status !== 'running') return
    if (checkpoint === undefined && this.progressed === undefined) return
    this.progressed = checkpoint
    this.journal?.save(this.toRecord())
  }

  /** Su pipeline se cortó en una pausa: queda `paused` hasta que la despierte un evento o venza.
   *  Devuelve su lugar y su task cuando `run` termina de desarmar la corrida. */
  pause(pause: Pause, checkpoint: Checkpoint): void {
    if (this.status !== 'running') {
      throw new Error(`${this.id}: no se puede pausar una ejecución ${this.status}`)
    }
    this.status = 'paused'
    this.step = undefined
    this.progressed = undefined
    this.paused = { pause, checkpoint }
    this.journal?.save(this.toRecord())
    this.log.info(`${this.id} se pausa en "${pause.pauseId}" (${pause.describe()})`, {
      'ia.execution.id': this.id,
      'ia.pause.id': pause.pauseId,
    })
  }

  /**
   * Si `event` despierta su pausa, vuelve a `running` en el acto (así otro evento no la despierta
   * dos veces) y devuelve la rama y por dónde seguir. Quien la despierta le pide al store que la
   * vuelva a admitir (`ExecutionStore.resume`) antes de correrla.
   */
  wake(event: DomainEvent<any>): Wake | undefined {
    if (this.status !== 'paused' || !this.paused) return undefined
    const branch = this.paused.pause.match(event)
    return branch ? this.resumeBy(branch) : undefined
  }

  /** Si su pausa venció (`now` ≥ `expiresAt`). */
  expired(now: number): boolean {
    return this.status === 'paused' && (this.paused?.pause.expired(now) ?? false)
  }

  /** La despierta por la rama `timeout`. Lo llama el engine con una pausa vencida. */
  wakeOnTimeout(): Wake | undefined {
    return this.status === 'paused' && this.paused ? this.resumeBy(TIMEOUT_BRANCH) : undefined
  }

  /** Corre `work` como esta ejecución: queda `done` o `failed` según termine, y se cierra — o,
   *  si se pausó en el medio, devuelve su lugar y su task sin cerrarse. */
  async run<T>(work: () => Promise<T>): Promise<T> {
    this.log.info(
      `${this.id} abre: ${this.pipelineId}${this.waitedMs > 0 ? ` (esperó ${this.waitedMs} ms)` : ''}`,
      { 'ia.execution.id': this.id, 'ia.execution.wait_ms': this.waitedMs },
    )
    try {
      const result = await work()
      if (this.status === 'paused') this.release()
      else if (this.interrupted) this.close('superseded', `interrupted by ${this.interrupted.by}`)
      else this.close('done')
      return result
    } catch (err) {
      // El motivo queda en `closeReason`: sin él, una ejecución `failed` no dice por qué.
      this.close('failed', err instanceof Error ? err.message : String(err))
      throw err
    }
  }

  /** La cierra (una sola vez): devuelve su task y su lugar al store. */
  close(status: ClosedStatus, reason?: string): void {
    if (this.status !== 'running' && this.status !== 'paused') return
    this.status = status
    this.step = undefined
    this.paused = undefined
    this.progressed = undefined
    this.inbox.takeMissed()
    this.closedAt = new Date().toISOString()
    this.closeReason = reason
    this.journal?.save(this.toRecord())
    this.log[status === 'done' ? 'info' : 'warn'](`${this.id} cierra: ${status}`, {
      'ia.execution.id': this.id,
      'ia.execution.duration_ms': Date.now() - this.startedMs,
    })
    this.release()
    this.settle()
  }

  /** @internal lo llama el store cada vez que le da lugar y task: `release` se los devuelve. */
  admit(release: () => void): void {
    this.releaser = release
  }

  toRecord(): ExecutionRecord {
    return {
      id: this.id,
      key: this.key,
      pipelineId: this.pipelineId,
      status: this.status,
      startedAt: this.startedAt,
      waitedMs: this.waitedMs,
      ...(this.closedAt ? { closedAt: this.closedAt } : {}),
      ...(this.closeReason ? { closeReason: this.closeReason } : {}),
      ...(this.paused
        ? { pause: this.paused.pause.toJSON(), checkpoint: this.paused.checkpoint }
        : this.progressed
          ? { checkpoint: this.progressed }
          : {}),
    }
  }

  private resumeBy(branch: string): Wake {
    const { checkpoint } = this.paused as { checkpoint: Checkpoint }
    this.status = 'running'
    this.paused = undefined
    this.inbox.takeMissed()
    this.journal?.save(this.toRecord())
    this.log.info(`${this.id} se reanuda por "${branch}"`, {
      'ia.execution.id': this.id,
      'ia.pause.branch': branch,
    })
    return { branch, checkpoint }
  }

  private markRead<T>(taken: T[]): T[] {
    if (taken.length > 0) this.journal?.read(this.id)
    return taken
  }

  private release(): void {
    const releaser = this.releaser
    this.releaser = undefined
    releaser?.()
  }
}
