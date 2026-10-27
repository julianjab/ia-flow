import { createLogger } from '@ia-flow/telemetry'
import type { DomainEvent } from '../events/DomainEvent.js'
import type { Checkpoint, IfPaused, IfQueued } from '../pipeline/Pipeline.js'
import {
  Execution,
  type ExecutionJournal,
  type ExecutionRecord,
  type ExecutionStatus,
} from './Execution.js'
import type { ExecutionRepository, QueuedRun } from './ExecutionRepository.js'
import { type ExecutionGroups, ExecutionScheduler } from './ExecutionScheduler.js'
import { InMemoryRunCounter } from './InMemoryRunCounter.js'
import { DEFAULT_RESUME_LIMITS, type ResumeLimits, resumeDelayMs } from './ResumeLimits.js'
import type { RunCounter } from './RunCounter.js'

export interface StartExecution {
  key: string
  pipelineId: string
  /** Si la task tiene una ejecución pausada cuando le toca: reemplazarla (default) o esperar a
   *  que termine (`Pipeline.ifPaused`). */
  ifPaused?: IfPaused
  /** Si ya hay una corrida de esta misma pipeline ESPERANDO turno en la task: reemplazarla
   *  (`replace`: la que esperaba no arranca, `start` le devuelve `undefined`) o encolarse detrás
   *  (`keep`, el default del store; el de una `Pipeline` es `replace`). La que ya corre nunca se
   *  reemplaza. */
  ifQueued?: IfQueued
  /** El evento que la disparó: mientras espera, queda anotado en el repositorio
   *  (`ExecutionRepository.queued`) y, si el proceso muere antes de que arranque, se re-despacha al
   *  reiniciar (`takeOrphaned`). */
  event?: DomainEvent<any>
}

/** Una corrida esperando turno que se puede reemplazar: la marca la corrida que llega después. */
interface QueuedTicket {
  replaced: boolean
}

export interface ExecutionStoreOptions {
  repository: ExecutionRepository
  /** Cuántas ejecuciones corren a la vez, entre todas las tasks. Default: sin tope. */
  maxConcurrent?: number
  /** Topes por grupo de tasks (ej. por proyecto), debajo del global. */
  groups?: ExecutionGroups
  /** El id de cada ejecución nueva. Default: un UUID (no se repite entre reinicios ni entre
   *  procesos, sin estado en el repositorio). */
  newId?: () => string
  /** Retomar tras un reinicio la que corría con un paso que guardaba su progreso (un agente y
   *  su conversación) o que acababa de despertar de una pausa. Default (`DEFAULT_RESUME_LIMITS`):
   *  hasta 10 veces seguidas, si se guardó hace menos de 24 h, con una espera que crece con los
   *  intentos y escalonadas de a una por minuto. */
  resume?: Partial<ResumeLimits>
  /** Dónde se cuentan las corridas de `maxRuns`. Default: en memoria (se pierde al reiniciar). */
  runs?: RunCounter
}

/** El tope de corridas que pide una pipeline (`MaxRuns`), visto desde el store. */
export interface RunBudget {
  counter: string
  max: number
  windowMs?: number
}

/** Lo que lee el agente que se retoma tras un reinicio. */
export const RESTART_NOTE =
  'El runner se reinició mientras trabajabas. Tu conversación sigue acá, pero lo que estaba en curso (un comando, una tool) pudo no terminar: verificá el estado antes de seguir. ' +
  'Si dejaste cambios sin commitear en tu worktree, el runner los guardó en un commit `WIP autosalvage from run <id>` sobre tu branch: miralo con `git log` y `git show` antes de rehacer nada — tu trabajo está ahí, y podés seguirlo o rearmar los commits con tus mensajes.'

/** Quien quiere enterarse de cada cambio de estado de una ejecución (arrancó, se pausó, se
 *  reanudó, cerró) — ej. marcar la task como en curso en un board. */
export type ExecutionListener = (record: ExecutionRecord) => void

/** Lo que una ejecución interrumpida (el proceso murió mientras corría) había recibido sin leer. */
export interface OrphanedEvents {
  executionId: string
  events: DomainEvent<any>[]
}

/**
 * Dónde viven las ejecuciones: una por task (serie por `key`), un tope global en paralelo
 * (`ExecutionScheduler`), y qué pasa con una pausa cuando a su task le toca otra corrida
 * (`ifPaused`). Cada ejecución le anota sus cambios al `ExecutionRepository`; con uno persistente,
 * al construirse recupera lo que quedó vivo: las pausadas vuelven a esperar; las que corrían con
 * un paso que guardaba su progreso, o recién despertadas de una pausa, se retoman ahí (quedan
 * pausadas con un vencimiento escalonado: un `tick` las corre — ver `ResumeLimits`); y las demás
 * se cierran `failed` (`interrupted`) y dejan lo que no leyeron en `takeOrphaned()` para que el
 * engine lo re-despache.
 */
export class ExecutionStore {
  readonly log = createLogger('agent-engine.execution')
  private readonly repository: ExecutionRepository
  private readonly scheduler: ExecutionScheduler
  private readonly byKey = new Map<string, Execution>()
  /** La última corrida `replace` esperando turno, por task y pipeline. */
  private readonly queued = new Map<string, QueuedTicket>()
  /** Cuántas veces se canceló cada task (`cancel`): una corrida que empezó a esperar antes de la
   *  última, cede el turno sin arrancar. */
  private readonly cancellations = new Map<string, number>()
  /** La espera anotada (`ExecutionRepository.queued`) de cada ejecución que arrancó y todavía no
   *  guardó por dónde seguir: si el proceso muere antes, su evento se re-despacha al reiniciar. */
  private readonly trigger = new Map<string, string>()
  private orphaned: OrphanedEvents[] = []
  /** El proceso se apaga (`close`): no arranca ni retoma nada más. */
  private closed = false
  private readonly resumeLimits: ResumeLimits
  private readonly newId: () => string
  private readonly listeners = new Set<ExecutionListener>()
  /** El último estado avisado de cada ejecución viva: se avisa un CAMBIO, no cada guardado. */
  private readonly lastStatus = new Map<string, ExecutionStatus>()
  /** Lo que pasó al recuperar (antes de que nadie pudiera escuchar): se le repite a cada nuevo. */
  private readonly recovered: ExecutionRecord[] = []
  private recovering = false
  /** El repositorio, más el aviso a los que escuchan. Es el journal de cada ejecución. */
  private readonly journal: ExecutionJournal
  private readonly runs: RunCounter

  constructor(options: ExecutionStoreOptions) {
    const max = options.maxConcurrent ?? Number.POSITIVE_INFINITY
    if (!(max >= 1)) {
      throw new Error(`${this.constructor.name}: maxConcurrent tiene que ser ≥ 1 (llegó ${max})`)
    }
    this.repository = options.repository
    this.journal = {
      save: (record) => this.save(record),
      delivered: (id, event) => this.repository.delivered(id, event),
      read: (id) => this.repository.read(id),
    }
    this.scheduler = new ExecutionScheduler(max, options.groups)
    this.runs = options.runs ?? new InMemoryRunCounter()
    this.newId = options.newId ?? (() => globalThis.crypto.randomUUID())
    this.resumeLimits = { ...DEFAULT_RESUME_LIMITS, ...options.resume }
    this.recovering = true
    this.recover()
    this.recovering = false
  }

  /** La de esta task, corriendo o pausada, si hay. */
  current(key: string): Execution | undefined {
    return this.byKey.get(key)
  }

  /**
   * Si a la task le queda lugar bajo el tope `budget` y, si le queda, cuenta esta corrida. Una
   * cuenta vieja (`windowMs`) arranca de cero. Síncrono: lo llama el coordinador con la corrida ya
   * con su turno, así dos corridas de la misma task no se cuentan en paralelo.
   */
  admitRun(key: string, budget: RunBudget, now = Date.now()): { allowed: boolean; count: number } {
    const current = this.runs.get(key, budget.counter)
    const stale =
      budget.windowMs !== undefined &&
      current.lastAt !== undefined &&
      now - current.lastAt > budget.windowMs
    if (stale) this.runs.reset(key, budget.counter)
    const count = stale ? 0 : current.count
    if (count >= budget.max) return { allowed: false, count }
    return { allowed: true, count: this.runs.hit(key, budget.counter, now) }
  }

  /** Pone en cero el contador `counter` de la task (sin `counter`, todos los suyos). */
  resetRuns(key: string, counter?: string): void {
    this.runs.reset(key, counter)
  }

  /** Si la task tiene una ejecución corriendo O esperando turno — una pausada no la ocupa. Se
   *  marca en el mismo tick del `start`/`resume`, así que no hay ventana en la que una task
   *  ocupada parezca libre. */
  busy(key: string): boolean {
    return this.scheduler.busy(key)
  }

  /**
   * Abre una ejecución: espera a que termine la que esté corriendo para la misma task (una task
   * nunca corre dos a la vez) y a que haya lugar bajo el tope global. Si la task tenía una
   * pausada, la reemplaza (`superseded`) — o, con `ifPaused: 'wait'`, espera a que termine SIN
   * ocupar la task ni un lugar, así la pausa puede despertar o vencer.
   *
   * Con `ifQueued: 'replace'`, una corrida de la misma pipeline que todavía esperaba turno en la
   * task queda reemplazada por ésta: cuando le toca, cede el turno sin arrancar y su `start`
   * devuelve `undefined`. Ésta toma el lugar del final de la cola — corre con el evento más nuevo.
   * También devuelve `undefined` si `cancel` cortó la task mientras esperaba: quien cancela tareas
   * pasa `ifQueued` (como el engine) y maneja ese caso.
   */
  start(props: StartExecution & { ifQueued: IfQueued }): Promise<Execution | undefined>
  start(props: Omit<StartExecution, 'ifQueued'>): Promise<Execution>
  async start({
    key,
    pipelineId,
    ifPaused = 'supersede',
    ifQueued = 'keep',
    event,
  }: StartExecution): Promise<Execution | undefined> {
    if (this.closed) return never()
    const queuedAt = Date.now()
    const cancelled = this.cancellations.get(key) ?? 0
    const ticket = ifQueued === 'replace' ? this.enqueueReplacing(key, pipelineId) : undefined
    const waiting = this.noteQueued(key, pipelineId, queuedAt, event)
    let execution: Execution | undefined
    try {
      execution = await this.takeTurn(key, pipelineId, queuedAt, ifPaused, ticket, cancelled)
      return execution
    } finally {
      // Ya arrancó: su espera queda anotada hasta que la ejecución guarde por dónde seguir (ver
      // `settleTrigger`). Arrancar no alcanza: si el proceso muere antes de que su agente guarde
      // la conversación, la ejecución se cierra `interrupted` y sin esto su evento se perdía
      // (subscriptions#2041: el refiner nunca corrió).
      if (waiting && execution?.status === 'running') this.trigger.set(execution.id, waiting)
      else if (waiting) this.repository.unqueued?.(waiting)
    }
  }

  /** La ejecución ya guardó por dónde seguir, se pausó o cerró: un reinicio la retoma (o ya no
   *  hay nada que retomar), así que su evento ya no se re-despacha. */
  private settleTrigger(record: ExecutionRecord): void {
    const waiting = this.trigger.get(record.id)
    if (!waiting) return
    if (record.status === 'running' && record.checkpoint === undefined) return
    this.trigger.delete(record.id)
    this.repository.unqueued?.(waiting)
  }

  /** Anota la espera con su evento, si el repositorio sabe guardarla. Devuelve su id. */
  private noteQueued(
    key: string,
    pipelineId: string,
    queuedAt: number,
    event: DomainEvent<any> | undefined,
  ): string | undefined {
    if (!event || !this.repository.queued) return undefined
    // Un id propio, no el de `newId`: el de la espera no es el de una ejecución.
    const id = `queued:${globalThis.crypto.randomUUID()}`
    this.repository.queued({
      id,
      key,
      pipelineId,
      queuedAt: new Date(queuedAt).toISOString(),
      event,
    })
    return id
  }

  /** Espera el turno de la task y un lugar bajo el tope, y abre la ejecución (o cede). */
  private async takeTurn(
    key: string,
    pipelineId: string,
    queuedAt: number,
    ifPaused: IfPaused,
    ticket: QueuedTicket | undefined,
    /** Las cancelaciones de la task cuando empezó a esperar (`cancel`). */
    cancelled: number,
  ): Promise<Execution | undefined> {
    for (;;) {
      const { ready, release } = this.scheduler.enter(key)
      await ready
      // Le tocó con el proceso apagándose: no arranca (su espera queda anotada y se re-despacha al
      // reiniciar). No devuelve el lugar: nada más tiene que arrancar.
      if (this.closed) return never()
      const ceded = this.cedes(key, ticket, cancelled)
      if (ceded) {
        release()
        if (ticket) this.dequeue(key, pipelineId, ticket)
        this.log.info(`${pipelineId} en cola para ${key} ${ceded}`, {
          'ia.pipeline.id': pipelineId,
        })
        return undefined
      }
      const previous = this.byKey.get(key)
      if (previous?.status === 'paused' && ifPaused === 'wait') {
        // Devuelve la task y el lugar mientras espera: reteniéndolos, la pausa no podría despertar
        // ni vencer (`wake` y `tick` no tocan una task ocupada) y se esperarían entre sí.
        release()
        this.log.info(`${pipelineId} espera a que ${previous.id} termine su pausa`, {
          'ia.execution.id': previous.id,
          'ia.pipeline.id': pipelineId,
        })
        await previous.finished
        continue
      }
      // Arranca: ya no está en cola, ninguna posterior la reemplaza.
      if (ticket) this.dequeue(key, pipelineId, ticket)
      // Primero cierra la pausa que reemplaza: una task tiene una sola ejecución viva.
      if (previous?.status === 'paused') previous.close('superseded')
      const execution = Execution.open({
        id: this.newId(),
        key,
        pipelineId,
        queuedAt,
        journal: this.journal,
      })
      this.admit(execution, release)
      return execution
    }
  }

  /** Por qué una corrida que esperaba turno ya no arranca —la reemplazó otra de su pipeline, o
   *  cancelaron la task—, o `undefined` si arranca. */
  private cedes(
    key: string,
    ticket: QueuedTicket | undefined,
    cancelled: number,
  ): string | undefined {
    if (ticket?.replaced) return 'quedó reemplazada por una más nueva'
    if ((this.cancellations.get(key) ?? 0) !== cancelled) return 'quedó cancelada'
    return undefined
  }

  /** Marca reemplazada la corrida de `pipelineId` que esperaba turno en `key`, y deja ésta. */
  private enqueueReplacing(key: string, pipelineId: string): QueuedTicket {
    const slot = queueSlot(key, pipelineId)
    const previous = this.queued.get(slot)
    if (previous) previous.replaced = true
    const ticket: QueuedTicket = { replaced: false }
    this.queued.set(slot, ticket)
    return ticket
  }

  private dequeue(key: string, pipelineId: string, ticket: QueuedTicket): void {
    const slot = queueSlot(key, pipelineId)
    if (this.queued.get(slot) === ticket) this.queued.delete(slot)
  }

  /**
   * Corta todo lo de la task (ver `Execution.cancel`): la ejecución pausada cierra `superseded`, la
   * que corre queda interrumpida sin seguir sus salidas, y las corridas que esperaban turno ceden
   * sin arrancar. Para una task que deja de ser de este engine (la tomó otro) o que una persona
   * para. Lo que llegue después corre como siempre. Devuelve qué cortó.
   */
  cancel(key: string, reason: string): { execution?: string; waiting: boolean } {
    const waiting = this.scheduler.waitingKeys().includes(key)
    if (waiting) this.cancellations.set(key, (this.cancellations.get(key) ?? 0) + 1)
    const current = this.byKey.get(key)
    const execution = current?.cancel(reason) ? current.id : undefined
    return { ...(execution ? { execution } : {}), waiting }
  }

  /** El proceso se apaga: las que corren dejan de anotarse y no corren su `onError` si fallan
   *  (`Execution.stop`) — quedan guardadas como estaban y se retoman al reiniciar —, y nada más
   *  arranca ni se retoma: lo que esperaba turno se queda esperando (su espera anotada se
   *  re-despacha al reiniciar). */
  close(): void {
    this.closed = true
    for (const execution of this.byKey.values()) execution.stop()
  }

  /** Vuelve a admitir una ejecución que despertó (`Execution.wake`): espera su turno en la task
   *  y lugar bajo el tope, igual que `start`. La parte que ocupa la task corre en el mismo tick. */
  async resume(execution: Execution): Promise<void> {
    if (this.closed) return never()
    const { ready, release } = this.scheduler.enter(execution.key)
    await ready
    if (this.closed) return never()
    this.admit(execution, release)
  }

  /** Las pausadas — para ver cuáles vencieron. */
  paused(): Execution[] {
    return [...this.byKey.values()].filter((execution) => execution.status === 'paused')
  }

  /** Las tasks con alguna corrida esperando turno — lo que la bandeja muestra "en cola". */
  waitingKeys(): string[] {
    return this.scheduler.waitingKeys()
  }

  get stats(): { running: number; waiting: number; paused: number } {
    return {
      running: this.scheduler.running,
      waiting: this.scheduler.waiting,
      paused: this.paused().length,
    }
  }

  /**
   * Avisa cada cambio de estado de una ejecución: al arrancar, pausarse, reanudarse y cerrar — no
   * cada guardado de su progreso. Lo que pasó al recuperar tras un reinicio (antes de que nadie
   * escuchara) se le repite al que se suma. Un listener que tira no frena la ejecución.
   */
  observe(listener: ExecutionListener): () => void {
    this.listeners.add(listener)
    for (const record of this.recovered) this.notify(listener, record)
    return () => this.listeners.delete(listener)
  }

  /** Lo que las ejecuciones interrumpidas por un reinicio recibieron sin leer — y lo consume. */
  takeOrphaned(): OrphanedEvents[] {
    const orphaned = this.orphaned
    this.orphaned = []
    return orphaned
  }

  private recover(): void {
    let restarted = 0
    for (const record of this.repository.live()) {
      if (record.status === 'paused') {
        this.track(Execution.restore(record, this.journal))
        continue
      }
      // Corría cuando el proceso murió: su agente murió con él.
      const events = this.repository.unread(record.id)
      this.repository.read(record.id)
      const resumable = this.resumable(record)
      if (resumable) {
        const paused = this.restartable(record, resumable, events, restarted++)
        this.track(Execution.restore(paused, this.journal))
        const via = resumable.branch ? ` por "${resumable.branch}"` : ''
        const inSeconds = Math.round(((paused.pause?.expiresAt ?? Date.now()) - Date.now()) / 1000)
        this.log.warn(
          `${record.id} se interrumpió con el proceso: se retoma en ${resumable.pauseId}${via} (intento ${paused.checkpoint?.attempts}, en ${inSeconds} s)`,
          {
            'ia.execution.id': record.id,
          },
        )
        continue
      }
      this.save({
        ...record,
        status: 'failed',
        closedAt: new Date().toISOString(),
        closeReason: 'interrupted',
      })
      if (events.length > 0) this.orphaned.push({ executionId: record.id, events })
      this.log.warn(`${record.id} se interrumpió con el proceso: queda failed`, {
        'ia.execution.id': record.id,
      })
    }
    this.recoverWaiting(this.repository.waiting?.() ?? [])
  }

  /**
   * Las corridas que esperaban turno o lugar cuando el proceso murió —o que ya habían arrancado
   * pero no guardaron por dónde seguir, y se cerraron `interrupted`—: su evento vuelve a pasar por
   * las reglas, como lo que una interrumpida no leyó (`takeOrphaned`). Una vez por evento: un
   * mismo evento pudo encolar varias pipelines, y re-despacharlo las vuelve a decidir a todas con
   * los hechos de ahora.
   */
  private recoverWaiting(waiting: QueuedRun[]): void {
    const seen = new Set<string>()
    for (const run of waiting) {
      this.repository.unqueued?.(run.id)
      if (seen.has(run.event.id)) continue
      seen.add(run.event.id)
      this.orphaned.push({ executionId: run.id, events: [run.event] })
      this.log.warn(
        `${run.pipelineId} no llegó a guardar progreso en ${run.key} antes del reinicio (esperaba turno o recién arrancaba): su evento se re-despacha`,
        { 'ia.pipeline.id': run.pipelineId },
      )
    }
  }

  /** El checkpoint desde el que se retoma una que corría, si guardó uno y no pasó los topes: lo
   *  que guardaba un paso (`state`, la conversación de un agente) o la pausa de la que acababa de
   *  despertar (`branch`). */
  private resumable(record: ExecutionRecord): Checkpoint | undefined {
    const checkpoint = record.checkpoint
    if (checkpoint === undefined) return undefined
    if (checkpoint.state === undefined && checkpoint.branch === undefined) return undefined
    const attempts = checkpoint.attempts ?? 0
    const age = Date.now() - Date.parse(checkpoint.savedAt ?? record.startedAt)
    if (attempts >= this.resumeLimits.maxAttempts || !(age <= this.resumeLimits.maxAgeMs)) {
      this.log.warn(
        `${record.id}: no se retoma (${attempts} intentos, guardado hace ${Math.round(age / 1000)} s)`,
        { 'ia.execution.id': record.id },
      )
      return undefined
    }
    return checkpoint
  }

  /** La que corría, como pausada que vence en `resumeDelayMs` (la primera de un reinicio, en el
   *  acto): el engine la retoma en el `tick` que sigue. `index` es cuántas se retoman antes que
   *  ella en este reinicio. Lo que había recibido sin leer va en el aviso al agente, no a otra
   *  corrida que la reemplazaría. */
  private restartable(
    record: ExecutionRecord,
    checkpoint: Checkpoint,
    unread: DomainEvent<any>[],
    index: number,
  ): ExecutionRecord {
    const pending = unread.map((event) => {
      const payload = JSON.stringify(event.payload)
      return `- ${event.type}: ${payload.length > 2_000 ? `${payload.slice(0, 2_000)}…` : payload}`
    })
    const note =
      pending.length > 0
        ? `${RESTART_NOTE}\n\nMientras tanto llegó:\n${pending.join('\n')}`
        : RESTART_NOTE
    const attempts = (checkpoint.attempts ?? 0) + 1
    const expiresAt = Date.now() + resumeDelayMs(attempts, index, this.resumeLimits)
    const paused: ExecutionRecord = {
      ...record,
      status: 'paused',
      pause: { pauseId: checkpoint.pauseId, branches: [], expiresAt },
      checkpoint: { ...checkpoint, note, attempts },
    }
    this.save(paused)
    return paused
  }

  /** Guarda y, si cambió su estado, avisa. */
  private save(record: ExecutionRecord): void {
    this.repository.save(record)
    this.settleTrigger(record)
    if (this.lastStatus.get(record.id) === record.status) return
    if (record.status === 'running' || record.status === 'paused') {
      this.lastStatus.set(record.id, record.status)
    } else {
      this.lastStatus.delete(record.id)
    }
    if (this.listeners.size === 0) {
      if (this.recovering) this.recovered.push(record)
      return
    }
    for (const listener of this.listeners) this.notify(listener, record)
  }

  private notify(listener: ExecutionListener, record: ExecutionRecord): void {
    try {
      listener(record)
    } catch (error) {
      this.log.warn(`un listener de ejecuciones falló: ${(error as Error).message}`, {
        'ia.execution.id': record.id,
      })
    }
  }

  private admit(execution: Execution, release: () => void): void {
    this.track(execution)
    execution.admit(release)
  }

  private track(execution: Execution): void {
    this.byKey.set(execution.key, execution)
    void execution.finished.then(() => {
      if (this.byKey.get(execution.key) === execution) this.byKey.delete(execution.key)
    })
  }
}

/** Lo que espera con el proceso apagándose: no termina nunca — ni arranca, ni toca la base. */
function never(): Promise<never> {
  return new Promise<never>(() => {})
}

function queueSlot(key: string, pipelineId: string): string {
  return JSON.stringify([key, pipelineId])
}
