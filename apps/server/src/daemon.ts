import { crashRecoveryEnabled, startupScanEnabled } from '@ia-flow/issue-sources'
import { createRuleEngineHandler, createWaitHandler, issueScannedEvent } from '@ia-flow/rules'
import { WAIT_EXPIRED, WAIT_RESUMED, createEvent, deriveEvent } from '@ia-flow/shared'
import { registerActions, setActiveManagers } from './composition/actions.js'
import {
  broadcast,
  buildManagers,
  classifyAgent,
  divergenceReconciler,
  eventBus,
  pollingPause,
  ruleRepo,
  waitRepo,
} from './composition/container.js'
import type { Disposable, IIssueManager, IssueItem } from './domain/ports/IIssueManager.js'
import { createLogger } from './logger.js'

const log = createLogger('daemon')

// Re-export broadcast.setFn for backward compatibility with index.ts
export function setBroadcast(fn: (msg: object) => void): void {
  broadcast.setFn(fn)
}

// Alive-set of running managers + their subscriptions. Held here so reload
// (see below) can dispose the previous generation cleanly before spawning
// the next one.
interface Running {
  manager: IIssueManager
  disposable: Disposable
}
let running: Running[] = []
// What the daemon is already managing, keyed by `${projectId}:${mode}` and
// reported by buildManagers — never derived from projectRepo.list(), which
// includes projects it skips (local kind, source without TransitionManager).
// Counting those as managed would deny them their first scan the day they get
// a usable source.
//
// A reload gives its catch-up pass only to keys missing here: a brand-new
// project, or one just switched polling→webhook, has never been scanned by
// this kind of manager — and in webhook mode nothing else would look at it
// until a delivery arrives (with no fallback timer, possibly never).
let managedKeys = new Set<string>()

const managedKey = (projectId: string, mode: string) => `${projectId}:${mode}`

// El scan publica un evento y el motor de reglas decide quién reacciona. El
// productor dejó de conocer a su consumidor, que es lo que permite que un
// `pr.opened` o un `ci.finished` entren por el mismo lugar sin tocar esta
// función.
//
// `publish` devuelve el outcome agregado porque `SourceDispatcher` lo necesita
// para decidir si el item vuelve al backlog; el bus no traga el `deferred`.
function startAll(managers: IIssueManager[]): Running[] {
  // Los handlers de acción necesitan resolver el manager de un proyecto para
  // poder correr un agente; se publican acá porque su ciclo de vida es el del
  // daemon, no el del container.
  setActiveManagers(managers)
  return managers.map((manager) => {
    const disposable = manager.start((item: IssueItem) => eventBus.publish(issueScannedEvent(item)))
    return { manager, disposable }
  })
}

// El motor de reglas es UN suscriptor para todo el proceso, no uno por manager:
// el filtro por ámbito lo hace `matchScope` contra el scope del evento, no el
// cableado. Por eso se registra una vez en el boot y sobrevive a los reloads.
function registerRuleEngine(): void {
  registerActions()
  eventBus.register(
    createRuleEngineHandler({
      // Por evento y no congelado: editar una regla en la UI tiene que
      // aplicar sin reiniciar el daemon.
      loadRules: (event) => ruleRepo.visibleTo(event.scope.projectId),
      // El `whenText` de una regla: un modelo lee el evento y dice si cumple.
      // Es el mismo clasificador que antes gateaba la activación de un agente
      // — lo que cambió es quién lo consulta. Un `null` (no se pudo decidir)
      // saltea la regla en vez de adivinar; ver createRuleEngineHandler.
      classifyRule: ({ rule, event }) => {
        const payload = event.payload as Record<string, unknown>
        return classifyAgent({
          task: {
            title: String(payload.title ?? ''),
            description: String(payload.description ?? ''),
            type: String(payload.type ?? '') as 'functional' | 'technical',
          },
          agent: { id: rule.id, whenText: rule.whenText ?? '' },
        })
      },
      emit: async (cause, type, payload, scope) => {
        // `deriveEvent` y no `createEvent`: hereda causationId y depth+1, que
        // es lo único que impide que dos reglas que se emiten entre sí hagan
        // un loop infinito.
        await eventBus.publish(
          deriveEvent(cause, {
            type,
            source: 'rule',
            scope: scope ?? {},
            payload: payload ?? {},
          }),
        )
      },
      onError: (err, { rule, position, kind }) =>
        log.error({ err, ruleId: rule.id, position, kind }, 'Rule action failed'),
      onMatch: ({ event, matched, rejectedSummary }) => {
        if (!matched.length) return
        log.info(
          { type: event.type, matched: matched.map((r) => r.id), rejected: rejectedSummary },
          'Rules matched',
        )
      },
    }),
  )
}

// Las esperas se suscriben APARTE del motor de reglas: son dos preguntas
// distintas sobre el mismo evento —"¿qué reglas aplican?" (config permanente)
// y "¿alguien estaba esperando esto?" (estado de runtime, de un solo uso)— y
// meterlas en un handler las acoplaría.
function registerWaits(): void {
  eventBus.register(
    createWaitHandler({
      loadWaits: (projectId) => waitRepo.listByProject(projectId),
      consume: (waitId) => waitRepo.consume(waitId),
      resume: async (wait, event) => {
        // Reanudar es publicar: `wait.resumed` lleva el evento que despertó
        // dentro de su payload, así que la regla que corre al agente decide
        // qué hacer con él igual que con cualquier otro evento. El engine no
        // cablea "despertar" con "correr" — eso lo hace la config.
        await eventBus.publish(
          deriveEvent(event, {
            type: WAIT_RESUMED,
            source: 'engine',
            scope: { projectId: wait.projectId, issueId: wait.taskId },
            payload: {
              waitId: wait.id,
              agentId: wait.resumeWith ?? wait.agentId,
              // Una PAUSA trae checkpoint; una espera común, no.
              paused: wait.checkpoint != null,
              cause: { type: event.type, payload: event.payload },
            },
          }),
        )
        return 'dispatched'
      },
      onError: (err, { waitId, event }) =>
        log.error({ err, waitId, type: event.type }, 'Fallo al reanudar una espera'),
    }),
  )
}

/**
 * Barrido de esperas vencidas.
 *
 * Emite `wait.expired` por cada una: qué hacer con un timeout lo decide una
 * regla, no el engine. Sin esto, un CI que nunca corre porque el workflow
 * tenía un error de sintaxis dejaría la task esperando para siempre.
 */
function startWaitSweep(): void {
  const tick = async () => {
    try {
      const expired = await waitRepo.listExpired(new Date().toISOString())
      for (const wait of expired) {
        // Consumir primero, igual que al despertar: un barrido que se solapa
        // con el anterior no puede emitir dos veces el mismo vencimiento.
        if (!(await waitRepo.consume(wait.id))) continue
        log.info({ waitId: wait.id, taskId: wait.taskId, on: wait.on }, 'Espera vencida')
        await eventBus.publish(
          createEvent({
            type: WAIT_EXPIRED,
            source: 'engine',
            scope: { projectId: wait.projectId, issueId: wait.taskId },
            payload: {
              waitId: wait.id,
              agentId: wait.resumeWith ?? wait.agentId,
              waitedFor: wait.on,
              paused: wait.checkpoint != null,
            },
          }),
        )
      }
    } catch (err) {
      log.error({ err }, 'Fallo el barrido de esperas vencidas')
    }
  }
  // Proceso-vida, como el DivergenceReconciler: no depende de qué managers
  // corren, así que un reload no lo toca.
  setInterval(() => void tick(), waitSweepIntervalMs())
}

/** Cada cuánto se buscan esperas vencidas. Un minuto: el vencimiento no
 *  necesita precisión —una espera de una hora tolera 60s de retraso— y un
 *  intervalo corto sería una query por minuto sin nada que hacer. */
function waitSweepIntervalMs(): number {
  const raw = Number(Bun.env.IA_FLOW_WAIT_SWEEP_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000
}

export async function startDaemon(): Promise<void> {
  // Real process boot: catch up on whatever moved while we were down.
  // Both passes are off-switchable, and each silence has a cost worth saying
  // out loud — otherwise "why is nothing happening?" is a log-less mystery.
  if (!startupScanEnabled()) {
    log.warn(
      'IA_FLOW_STARTUP_SCAN=0 — no boot scan: en modo webhook nada se despacha hasta el primer delivery',
    )
  }
  if (!crashRecoveryEnabled()) {
    log.warn(
      'IA_FLOW_CRASH_RECOVERY=0 — no se limpian flags `working` de runs muertos: esas tasks quedan trabadas',
    )
  }
  // Re-arm the pause switch before any manager exists, so a project paused
  // before the restart doesn't get one free scan on the way up.
  const paused = pollingPause.hydrate()
  if (paused.length) log.info({ paused }, 'Polling pausado (persistido) para estos proyectos')
  // Antes de levantar los managers: el motor de reglas tiene que estar
  // suscripto para no perderse los eventos del scan de boot.
  registerRuleEngine()
  registerWaits()
  const built = buildManagers({ boot: true })
  running = startAll(built.managers)
  managedKeys = built.keys
  // Process-lifetime, started once — never recreated by reloadManagers()
  // below. It doesn't depend on which managers are running, only on
  // pendingTasks + the live project/source config it re-resolves per tick.
  divergenceReconciler.start()
  startWaitSweep()
  log.info({ count: running.length }, 'Daemon started')
}

// Called after any mutation to the projects table so the polling set matches
// current state (e.g. adding a project spins up a manager immediately, editing
// its URL swaps the underlying source, archiving stops the poll loop).
export function reloadManagers(): void {
  const prev = running.length
  for (const r of running) {
    try {
      r.disposable.dispose()
    } catch (err) {
      log.warn({ err }, 'Manager dispose threw — continuing')
    }
  }
  // boot:false — el daemon no se cayó, así que nadie corre crash-recovery (le
  // borraría el flag `working` a runs en vuelo). Los managers nuevos igual
  // hacen su primer scan: en modo webhook nada más los miraría.
  const known = managedKeys
  const built = buildManagers({
    boot: false,
    isNew: (projectId, mode) => !known.has(managedKey(projectId, mode)),
  })
  running = startAll(built.managers)
  managedKeys = built.keys
  log.info({ prev, next: running.length }, 'Managers reloaded')
}
