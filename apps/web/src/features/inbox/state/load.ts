import type { Inbox } from '@ia-flow/shared'
import { ref } from 'vue'
import { extractErrorMessage } from '@/composables/extractErrorMessage'
import { getInbox, getTasks } from '@/features/inbox/api'
import { createDashboardOverride, type DashboardOverride } from '@/features/inbox/state/dashboard'

// La carga de la bandeja: lo que el runner publica (hechos) más el dashboard de este runner
// (`dashboard.ts`), o —con un runner viejo, sin `/api/tasks`— su inbox ya clasificado. Vive
// dentro del store (`store.ts` la compone): se separa para que cada parte se lea sola.

type Outcome = { next: Inbox } | { error: string } | null

/** Pide y arma una carga; si mientras tanto se pidió otra (`stale`), no toca el dashboard. */
async function fetchNext(stale: () => boolean, override: DashboardOverride): Promise<Outcome> {
  try {
    const tasks = await getTasks()
    if (stale()) return null
    if (tasks) return { next: override.apply(tasks) }
    override.clear()
    return { next: await getInbox() }
  } catch (err) {
    return { error: extractErrorMessage(err) }
  }
}

export function createBoardLoad() {
  const inbox = ref<Inbox | null>(null)
  const override = createDashboardOverride(inbox)
  const loading = ref(false)
  const error = ref<string | null>(null)
  /** Filtro por proyecto (`null` = todos). Sólo se ofrece con más de uno. */
  const project = ref<string | null>(null)
  /** La hora contra la que se mide la antigüedad: se renueva con cada carga. */
  const now = ref(Date.now())

  /** Deja a la vista una carga nueva. Un proyecto que ya no existe no puede seguir filtrando. */
  function commit(next: Inbox): void {
    now.value = Date.now()
    inbox.value = next
    error.value = null
    if (project.value && !next.projects.some((p) => p.id === project.value)) project.value = null
  }

  /** Una respuesta que llegó después de que se pidió otra no pisa la más nueva. */
  let refreshSeq = 0
  async function refresh(): Promise<void> {
    const seq = ++refreshSeq
    const stale = () => seq !== refreshSeq
    // Sólo la primera carga muestra "cargando": un refresco por el stream no hace parpadear.
    if (!inbox.value) loading.value = true
    const outcome = await fetchNext(stale, override)
    if (stale() || !outcome) return
    loading.value = false
    if ('error' in outcome) error.value = outcome.error
    else commit(outcome.next)
  }

  const { dashboard, view, saveDashboard, resetDashboard } = override
  return {
    inbox,
    dashboard,
    view,
    loading,
    error,
    project,
    now,
    refresh,
    saveDashboard,
    resetDashboard,
  }
}
