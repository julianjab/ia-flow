import { defineStore } from 'pinia'
import { createActions } from '@/features/inbox/state/actions'
import { createDetails } from '@/features/inbox/state/details'
import { createLive } from '@/features/inbox/state/live'
import { createBoardLoad } from '@/features/inbox/state/load'
import { createQueue } from '@/features/inbox/state/queue'
import { createRest } from '@/features/inbox/state/rest'
import { useImprovementsSignalStore } from '@/stores/improvementsSignal'

export type { ActionState } from '@/features/inbox/state/actions'
export type { DetailState } from '@/features/inbox/state/details'

// La bandeja: la carga (hechos + dashboard, o el inbox de un runner viejo), la tarea abierta, el
// resto del board, las acciones, el stream y la cola de decisiones que se dibuja —cada parte en
// `state/`—. Este archivo sólo las compone.

export const useInboxStore = defineStore('inbox', () => {
  const signal = useImprovementsSignalStore()
  const load = createBoardLoad()
  const detail = createDetails()
  const board = createRest(() => load.project.value)
  const queue = createQueue(load)
  const act = createActions(async (ref) => {
    await load.refresh()
    if (detail.openRef.value === ref) void detail.loadDetail(ref, { silent: true })
  })
  const live = createLive({
    refresh: load.refresh,
    openRef: () => detail.openRef.value,
    reloadOpen: (ref) => void detail.loadDetail(ref, { silent: true }),
    bump: () => signal.bump(),
    trace: detail.appendTrace,
    event: detail.appendEvent,
  })

  /** Abre una tarea pedida desde afuera (el asistente): sin filtros que la escondan. */
  function focus(ref: string): void {
    queue.queueFilter.value = null
    const item = load.inbox.value?.items.find((i) => i.ref === ref)
    if (item && load.project.value && item.project_id !== load.project.value)
      load.project.value = null
    detail.open(ref)
  }

  const { openRef, expanded, details, loadDetail, toggle, expand, collapse } = detail
  return {
    ...load,
    ...board,
    ...act,
    ...live,
    ...queue,
    openRef,
    expanded,
    details,
    loadDetail,
    toggle,
    expand,
    collapse,
    focus,
  }
})
