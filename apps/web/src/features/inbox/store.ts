import { defineStore } from 'pinia'
import { createActions } from '@/features/inbox/state/actions'
import { createArrange } from '@/features/inbox/state/arrange'
import { createDetails } from '@/features/inbox/state/details'
import { createEpic } from '@/features/inbox/state/epic'
import { createLive } from '@/features/inbox/state/live'
import { createBoardLoad } from '@/features/inbox/state/load'
import { createMoves } from '@/features/inbox/state/moves'
import { createQueue } from '@/features/inbox/state/queue'
import { createRepoIssues } from '@/features/inbox/state/repoIssues'
import { createRest } from '@/features/inbox/state/rest'
import { createSearch } from '@/features/inbox/state/search'
import { useImprovementsSignalStore } from '@/stores/improvementsSignal'

export type { ActionState } from '@/features/inbox/state/actions'
export type { DetailState } from '@/features/inbox/state/details'
export type { EpicState } from '@/features/inbox/state/epic'
export type { AddState } from '@/features/inbox/state/moves'

// La bandeja: la carga (hechos + dashboard, o el inbox de un runner viejo), la tarea abierta, la
// épica abierta, el resto del board, las acciones, mover y agregar cards, el stream y la cola de decisiones que se dibuja —cada parte en
// `state/`—. Este archivo sólo las compone.

export const useInboxStore = defineStore('inbox', () => {
  const signal = useImprovementsSignalStore()
  const load = createBoardLoad()
  const detail = createDetails()
  const epic = createEpic()
  const board = createRest(() => load.project.value)
  const repos = createRepoIssues(() => load.project.value)
  const prefs = createArrange()
  const queue = createQueue(load, prefs)
  const act = createActions(async (ref) => {
    await load.refresh()
    if (detail.openRef.value === ref) void detail.loadDetail(ref, { silent: true })
  })
  // Agregar un issue al board lo saca de «En los repos, sin card»: se relee también esa lista.
  const moves = createMoves(async () => {
    await load.refresh()
    if (repos.repoIssues.value) void repos.loadRepoIssues()
  })
  const search = createSearch({
    scoped: queue.scoped,
    inbox: load.inbox,
    runner: load.runner,
    rest: board.rest,
    loadRest: board.loadRest,
    restLoading: board.restLoading,
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

  const { sort, isPinned, togglePin, snooze, wake, undoSnooze, lastSnoozed } = prefs
  const { openRef, expanded, details, loadDetail, toggle, expand, collapse } = detail
  return {
    ...load,
    ...board,
    ...repos,
    ...act,
    ...moves,
    ...live,
    ...queue,
    ...search,
    ...epic,
    openRef,
    expanded,
    details,
    loadDetail,
    toggle,
    expand,
    collapse,
    focus,
    sort,
    isPinned,
    togglePin,
    snooze,
    wake,
    undoSnooze,
    lastSnoozed,
    reloadPrefs: prefs.reload,
  }
})
