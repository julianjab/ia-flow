import { broadcast, buildManagers, dispatcher } from './composition/container.js'
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
  running = startAll(buildManagers({ catchUp: true }))
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
  // catchUp:false — el daemon no se cayó: re-correr crash-recovery borraría el
  // flag `working` de runs en vuelo y el scan re-despacharía trabajo vivo.
  running = startAll(buildManagers({ catchUp: false }))
  log.info({ prev, next: running.length }, 'Managers reloaded')
}
