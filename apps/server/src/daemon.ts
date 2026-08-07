import { broadcast, buildManagers, dispatcher } from './composition/container.js'
import type { IssueItem } from './domain/ports/IIssueManager.js'
import { createLogger } from './logger.js'

const log = createLogger('daemon')

// Re-export broadcast.setFn for backward compatibility with index.ts
export function setBroadcast(fn: (msg: object) => void): void {
  broadcast.setFn(fn)
}

export async function startDaemon(): Promise<void> {
  const dispatchFn = (
    item: IssueItem,
    manager: import('./domain/ports/IIssueManager.js').IIssueManager,
  ) =>
    dispatcher
      .dispatch(item, manager)
      .catch((err) => log.error({ err, id: item.id }, 'Unhandled dispatch error'))

  const managers = await buildManagers((item) => {
    // This version is called from buildManagers — no manager reference available.
    // The real dispatch happens via manager.start() below.
    return Promise.resolve()
  })

  for (const manager of managers) {
    manager.start((item: IssueItem) =>
      dispatcher
        .dispatch(item, manager)
        .catch((err) => log.error({ err, id: item.id }, 'Unhandled dispatch error')),
    )
  }
}
