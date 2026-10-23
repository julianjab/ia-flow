import type { InboxItem } from '@ia-flow/shared'
import { computed, ref, watch } from 'vue'
import { arrange } from '@/features/inbox/queue/arrange'
import { buildQueue, type InboxQueue } from '@/features/inbox/queue/build'
import { withColumns } from '@/features/inbox/queue/columns'
import type { QueueType } from '@/features/inbox/queue/kinds'
import type { createArrange } from '@/features/inbox/state/arrange'
import type { createBoardLoad } from '@/features/inbox/state/load'

// La cola de decisiones que se dibuja (Lo primero, Después, pipeline, feed) sobre la carga, tras
// el filtro de proyecto y el de tipo. Vive dentro del store (`store.ts` la compone).

type BoardLoad = ReturnType<typeof createBoardLoad>
type Arrange = ReturnType<typeof createArrange>

export function createQueue(load: BoardLoad, prefs: Arrange) {
  /** Con sus columnas: si `/api/tasks` no las trae, las de `/api/inbox`. */
  const projects = computed(() =>
    withColumns(load.inbox.value?.projects ?? [], load.runner.value?.projects ?? []),
  )
  /** Lo que se ve tras el filtro de proyecto: la base de la cola. */
  const scoped = computed<InboxItem[]>(() => {
    const items = load.inbox.value?.items ?? []
    const project = load.project.value
    return project ? items.filter((i) => i.project_id === project) : items
  })
  const total = computed(() => scoped.value.length)
  /** Cada card del board con su última corrida, tras el filtro de proyecto; con un runner viejo
   *  (sin `/api/tasks`), ausente: la cola usa las corridas de los items. */
  const runs = computed(() => {
    const tasks = load.facts.value?.tasks
    if (!tasks) return undefined
    const project = load.project.value
    return tasks
      .filter((t) => !project || t.project_id === project)
      .map((t) => ({ ref: t.ref, title: t.title, url: t.url, run: t.last_run }))
  })

  /** Las decisiones en el orden que eligió quien mira, sin las pospuestas (`queue/arrange.ts`). */
  const arranged = computed(() =>
    arrange({
      items: scoped.value,
      sort: prefs.sort.value,
      pins: prefs.pins.value,
      snoozes: prefs.snoozes.value,
      now: load.now.value,
    }),
  )
  /** Las pospuestas que siguen pospuestas: van plegadas al final de «Para mí». */
  const snoozed = computed(() => arranged.value.snoozed)
  // Con la bandeja cargada (y sin filtro de proyecto, que esconde otras), se olvida lo que ya no
  // aplica: una fijada que dejó de necesitarte, una pospuesta que volvió.
  watch(arranged, (out) => {
    if (load.inbox.value && !load.project.value) prefs.prune(out.pinned, out.activeSnoozes)
  })

  /** El filtro por tipo de la cola (`null` = todas). */
  const queueFilter = ref<QueueType | null>(null)
  /** La cola. Lo que el dashboard no define (feed, capacidad) lo pone el runner (`/api/inbox`). */
  const queue = computed<InboxQueue>(() => {
    const view = load.view.value
    return buildQueue({
      items: arranged.value.items,
      capacity: view?.capacity ?? null,
      feed: view?.feed ?? null,
      runner: load.runner.value,
      hygiene: view?.hygiene ?? [],
      filter: queueFilter.value,
      ...(runs.value ? { runs: runs.value } : {}),
      now: load.now.value,
    })
  })

  function setQueueFilter(type: QueueType | null): void {
    queueFilter.value = queueFilter.value === type ? null : type
  }

  return { projects, scoped, total, queue, queueFilter, setQueueFilter, snoozed }
}
