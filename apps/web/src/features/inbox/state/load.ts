import type { Inbox } from '@ia-flow/shared'
import { computed, ref } from 'vue'
import { extractErrorMessage } from '@/composables/extractErrorMessage'
import { getInbox, getTasks } from '@/features/inbox/api'
import { createDashboardOverride, type DashboardPanels } from '@/features/inbox/state/dashboard'
import { type Phase, sectionsOf } from '@/features/inbox/state/sections'

// La carga de la bandeja: lo que el runner publica (hechos) más el dashboard de este runner
// (`dashboard.ts`), o —con un runner viejo, sin `/api/tasks`— su inbox ya clasificado. Vive
// dentro del store (`store.ts` la compone): se separa para que cada parte se lea sola.
//
// Dos pedidos, en paralelo y sin esperarse: `/api/tasks` (las decisiones, las épicas, la
// capacidad) y, si el dashboard no define el feed o el pipeline, `/api/inbox` (el `feed` y el
// `pipeline` que manda el runner). Cada uno, al llegar, pinta lo suyo (`sections.ts`). Sólo la
// primera carga pasa por «cargando»: un refresco mantiene lo pintado hasta tener algo nuevo.

export function createBoardLoad() {
  const inbox = ref<Inbox | null>(null)
  /** `/api/inbox` tal como lo manda el runner: el respaldo del feed y del pipeline. */
  const runner = ref<Inbox | null>(null)
  const override = createDashboardOverride(inbox)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const runnerError = ref<string | null>(null)
  const decisionsPhase = ref<Phase>('idle')
  const runnerPhase = ref<Phase>('idle')
  /** Los paneles del dashboard; `null` con un runner viejo. */
  const panels = ref<DashboardPanels | null>(null)
  /** Filtro por proyecto (`null` = todos). Sólo se ofrece con más de uno. */
  const project = ref<string | null>(null)
  /** La hora contra la que se mide la antigüedad: se renueva con cada carga. */
  const now = ref(Date.now())

  const sections = computed(() =>
    sectionsOf({
      decisions: decisionsPhase.value,
      runner: runnerPhase.value,
      panels: panels.value,
    }),
  )

  /** Deja a la vista una carga nueva. Un proyecto que ya no existe no puede seguir filtrando. */
  function commit(next: Inbox): void {
    now.value = Date.now()
    inbox.value = next
    error.value = null
    decisionsPhase.value = 'ready'
    if (project.value && !next.projects.some((p) => p.id === project.value)) project.value = null
  }

  /** Una respuesta que llegó después de que se pidió otra no pisa la más nueva. */
  let refreshSeq = 0

  /** `/api/inbox`, una vez por carga: lo comparten el respaldo del feed y el runner viejo. */
  function runnerRequest(stale: () => boolean) {
    let pending: Promise<Inbox> | null = null
    const ask = () => {
      if (pending) return pending
      if (!runner.value) runnerPhase.value = 'loading'
      // Envuelto: un fallo síncrono también termina en el `catch` de esta sección, no en el refresco.
      pending = new Promise<Inbox>((resolve) => resolve(getInbox()))
      pending.then(
        (next) => {
          if (stale()) return
          runner.value = next ?? null
          runnerError.value = null
          runnerPhase.value = 'ready'
        },
        (err) => {
          if (stale()) return
          runnerError.value = extractErrorMessage(err)
          if (!runner.value) runnerPhase.value = 'error'
        },
      )
      return pending
    }
    /** Lo que se pidió en esta carga, si se pidió. */
    const sent = () => pending
    return { ask, sent }
  }

  /** Qué paneles hay que pedirle al runner; con un dashboard roto, los dos. */
  function wantedPanels(): DashboardPanels {
    try {
      return override.panels()
    } catch {
      return { feed: false, pipeline: false }
    }
  }

  /** Lo que se ve mientras llega la primera carga, y qué se le pide al runner en paralelo. */
  function begin(stale: () => boolean) {
    if (!inbox.value) {
      loading.value = true
      decisionsPhase.value = 'loading'
    }
    const wanted = wantedPanels()
    if (panels.value !== null || !inbox.value) panels.value = wanted
    const runnerReq = runnerRequest(stale)
    if (!wanted.feed || !wanted.pipeline) void runnerReq.ask()
    else if (runnerPhase.value === 'loading') runnerPhase.value = 'idle'
    return runnerReq
  }

  /** Las decisiones: los hechos + el dashboard o, con un runner viejo, su inbox clasificado. */
  async function nextDecisions(askRunner: () => Promise<Inbox>): Promise<Inbox | null> {
    const tasks = await getTasks()
    if (tasks) return override.apply(tasks)
    // Un runner viejo clasifica él: todo sale de `/api/inbox` (el mismo pedido, si ya salió).
    override.clear()
    panels.value = null
    return askRunner()
  }

  async function refresh(): Promise<void> {
    const seq = ++refreshSeq
    const stale = () => seq !== refreshSeq
    const runnerReq = begin(stale)
    try {
      const next = await nextDecisions(runnerReq.ask)
      if (!stale() && next) commit(next)
    } catch (err) {
      if (!stale()) {
        error.value = extractErrorMessage(err)
        if (!inbox.value) decisionsPhase.value = 'error'
      }
    }
    if (!stale()) loading.value = false
    // Quien espera el refresco (las acciones, los tests) ve también el respaldo ya aplicado.
    await runnerReq.sent()?.catch(() => undefined)
  }

  const { dashboard, view, saveDashboard, resetDashboard } = override
  return {
    inbox,
    runner,
    dashboard,
    view,
    loading,
    error,
    runnerError,
    sections,
    project,
    now,
    refresh,
    saveDashboard,
    resetDashboard,
  }
}
