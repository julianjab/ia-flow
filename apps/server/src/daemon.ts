import { broadcast, buildManagers, dispatcher, projectRepo } from './composition/container.js'
import type { Disposable, IIssueManager, IssueItem } from './domain/ports/IIssueManager.js'
import { resolveDaemonMode } from './issue-managers/daemon-mode.js'
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
// What the daemon is already managing, keyed by `${projectId}:${mode}`. A
// reload gives its catch-up pass only to keys missing here: a brand-new
// project, or one just switched polling→webhook, has never been scanned by
// this kind of manager — and in webhook mode nothing else would look at it
// until a delivery arrives (with no fallback timer, possibly never).
let managedKeys = new Set<string>()

const managedKey = (projectId: string, mode: string) => `${projectId}:${mode}`

function currentManagedKeys(): Set<string> {
  return new Set(projectRepo.list().map((p) => managedKey(p.id, resolveDaemonMode(p))))
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
  managedKeys = currentManagedKeys()
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
  const known = managedKeys
  running = startAll(
    buildManagers({ catchUpFor: (projectId, mode) => !known.has(managedKey(projectId, mode)) }),
  )
  managedKeys = currentManagedKeys()
  log.info({ prev, next: running.length }, 'Managers reloaded')
}
