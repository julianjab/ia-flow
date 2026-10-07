import type { InboxItem } from '@ia-flow/shared'
import { computed, ref } from 'vue'
import { buildQueue, type InboxQueue } from '@/features/inbox/queue/build'
import type { QueueType } from '@/features/inbox/queue/kinds'
import type { createBoardLoad } from '@/features/inbox/state/load'

// La cola de decisiones que se dibuja (Lo primero, Después, pipeline, feed) sobre la carga, tras
// el filtro de proyecto y el de tipo. Vive dentro del store (`store.ts` la compone).

type BoardLoad = ReturnType<typeof createBoardLoad>

export function createQueue(load: BoardLoad) {
  const projects = computed(() => load.inbox.value?.projects ?? [])
  /** Lo que se ve tras el filtro de proyecto: la base de la cola. */
  const scoped = computed<InboxItem[]>(() => {
    const items = load.inbox.value?.items ?? []
    const project = load.project.value
    return project ? items.filter((i) => i.project_id === project) : items
  })
  const total = computed(() => scoped.value.length)

  /** El filtro por tipo de la cola (`null` = todas). */
  const queueFilter = ref<QueueType | null>(null)
  /** La cola. Un runner viejo: sin capacity ni feed. */
  const queue = computed<InboxQueue>(() => {
    const view = load.view.value
    return buildQueue({
      items: scoped.value,
      capacity: view?.capacity ?? null,
      feed: view?.feed ?? null,
      hygiene: view?.hygiene ?? [],
      filter: queueFilter.value,
      now: load.now.value,
    })
  })

  function setQueueFilter(type: QueueType | null): void {
    queueFilter.value = queueFilter.value === type ? null : type
  }

  return { projects, scoped, total, queue, queueFilter, setQueueFilter }
}
