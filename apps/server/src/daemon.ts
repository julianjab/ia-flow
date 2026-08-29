import { createIssueScannedHandler, issueScannedEvent } from '@ia-flow/agent-engine'
import { crashRecoveryEnabled, startupScanEnabled } from '@ia-flow/issue-sources'
import {
  broadcast,
  buildManagers,
  dispatcher,
  divergenceReconciler,
  eventBus,
  pollingPause,
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
  /** Baja la suscripción del manager al bus. Va junto al disposable porque su
   *  ciclo de vida es el mismo: un reload que dispusiera el manager y dejara
   *  su handler registrado haría que el bus entregue eventos a un manager
   *  muerto — y como los handlers se filtran por projectId, el proyecto
   *  quedaría con dos suscriptores tras cada reload. */
  unregister: () => void
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

// El scan ya no llama al dispatcher: publica un evento y el bus decide quién
// reacciona. Hoy hay un único suscriptor por manager —el handler que corre un
// agente, o sea exactamente lo que se hacía antes—, así que el comportamiento
// es idéntico. Lo que cambia es que el productor dejó de conocer a su
// consumidor, que es lo que permite que mañana un `pr.opened` o un
// `ci.finished` entren por el mismo lugar sin tocar esta función.
//
// `publish` devuelve el outcome agregado porque `SourceDispatcher` todavía lo
// necesita para decidir si el item vuelve al backlog; el bus no traga el
// `deferred`. El catch de errores se mudó adentro del bus, con el mismo
// criterio de antes (un throw es `skipped`, no falta de capacidad).
function startAll(managers: IIssueManager[]): Running[] {
  return managers.map((manager) => {
    const projectId = manager.projectId
    const unregister = eventBus.register(
      createIssueScannedHandler(manager, projectId, (item, m) => dispatcher.dispatch(item, m)),
    )
    const disposable = manager.start((item: IssueItem) => eventBus.publish(issueScannedEvent(item)))
    return { manager, disposable, unregister }
  })
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
  const built = buildManagers({ boot: true })
  running = startAll(built.managers)
  managedKeys = built.keys
  // Process-lifetime, started once — never recreated by reloadManagers()
  // below. It doesn't depend on which managers are running, only on
  // pendingTasks + the live project/source config it re-resolves per tick.
  divergenceReconciler.start()
  log.info({ count: running.length }, 'Daemon started')
}

// Called after any mutation to the projects table so the polling set matches
// current state (e.g. adding a project spins up a manager immediately, editing
// its URL swaps the underlying source, archiving stops the poll loop).
export function reloadManagers(): void {
  const prev = running.length
  for (const r of running) {
    // Primero el bus: un handler que sobrevive a su manager le entregaría
    // eventos a uno dispuesto, y como se filtran por projectId el proyecto
    // acumularía un suscriptor más por cada reload.
    try {
      r.unregister()
    } catch (err) {
      log.warn({ err }, 'Event handler unregister threw — continuing')
    }
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
