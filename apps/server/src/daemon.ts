import { broadcast, buildManagers, dispatcher, projectRepo } from './composition/container.js'
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
// Projects the daemon is already managing. A reload gives its catch-up pass
// only to ids missing here — a brand-new project (or one just switched to
// webhook mode) has never been scanned, and in webhook mode nothing else
// would look at it until a delivery arrives.
let managedProjectIds = new Set<string>()

function currentProjectIds(): Set<string> {
  return new Set(projectRepo.list().map((p) => p.id))
}

function startAll(managers: IIssueManager[]): Running[] {
  return managers.map((manager) => {
    const disposable = manager.start((item: IssueItem) =>
      dispatcher
        .dispatch(item, manager)
        .catch((err) => log.error({ err, id: item.id }, 'Unhandled dispatch error')),
    )
    return { manager, disposable }
  })
}

export async function startDaemon(): Promise<void> {
  // Real process boot: catch up on whatever moved while we were down.
  running = startAll(buildManagers({ catchUpFor: () => true }))
  managedProjectIds = currentProjectIds()
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
  // Sólo los proyectos nuevos hacen catch-up: para los que ya venían corriendo,
  // el daemon nunca se cayó, y re-correr crash-recovery borraría el flag
  // `working` de runs en vuelo mientras el scan re-despacharía trabajo vivo.
  const known = managedProjectIds
  running = startAll(buildManagers({ catchUpFor: (projectId) => !known.has(projectId) }))
  managedProjectIds = currentProjectIds()
  log.info({ prev, next: running.length }, 'Managers reloaded')
}
