import type { Inbox, Tasks } from '@ia-flow/shared'
import { type Ref, ref } from 'vue'
import { serverTarget } from '@/composables/useServerTarget'
import { DashboardError, parseDashboard } from '@/features/inbox/view/dashboard'
import { buildView, type DashboardView } from '@/features/inbox/view/decide'
import { type ResolvedDashboard, resolveDashboard, serverKey } from '@/features/inbox/view/resolve'
import { clearOverride, saveOverride } from '@/features/inbox/view/storage'

// El dashboard de este runner aplicado a los hechos (`/api/tasks`), y su edición local: guardar
// uno propio o volver al que trae la web reaplica sobre la última carga sin pedirla de nuevo.
// Vive dentro de la carga (`load.ts` la compone y le pasa la bandeja que tiene que reescribir).

export function createDashboardOverride(inbox: Ref<Inbox | null>) {
  /** El dashboard de este runner y lo que sale de aplicarlo; `null` con un runner viejo. */
  const dashboard = ref<ResolvedDashboard | null>(null)
  const view = ref<DashboardView | null>(null)
  let lastTasks: Tasks | null = null

  /** Hechos + dashboard → la bandeja que se dibuja. */
  function apply(tasks: Tasks): Inbox {
    lastTasks = tasks
    const resolved = resolveDashboard(serverKey(serverTarget().base))
    dashboard.value = resolved
    view.value = buildView(tasks, resolved.dashboard)
    return { generated_at: tasks.generated_at, projects: tasks.projects, items: view.value.items }
  }

  /** Qué paneles define el dashboard que le toca a este runner: lo que no define, lo pone el
   *  runner (`/api/inbox`). Se sabe antes de pedir nada: decide qué se pide en paralelo. */
  function panels(): DashboardPanels {
    const { dashboard: chosen } = resolveDashboard(serverKey(serverTarget().base))
    return { feed: chosen.panels.feed !== undefined, pipeline: chosen.panels.pipeline }
  }

  /** Un runner sin `/api/tasks` clasifica él: sin dashboard. */
  function clear(): void {
    lastTasks = null
    dashboard.value = null
    view.value = null
  }

  function reapply(): void {
    if (lastTasks && inbox.value) inbox.value = apply(lastTasks)
  }

  /** Guarda el dashboard editado para ESTE runner y lo aplica ya. Inválido: devuelve por qué. */
  function saveDashboard(text: string): string | null {
    try {
      parseDashboard(text)
    } catch (err) {
      return err instanceof DashboardError ? err.message : String(err)
    }
    saveOverride(serverKey(serverTarget().base), text)
    reapply()
    return null
  }

  /** Vuelve al dashboard que trae la web para este runner. */
  function resetDashboard(): void {
    clearOverride(serverKey(serverTarget().base))
    reapply()
  }

  return { dashboard, view, apply, clear, panels, saveDashboard, resetDashboard }
}

export type DashboardOverride = ReturnType<typeof createDashboardOverride>

/** Los paneles que trae el dashboard: sin ellos, el feed y el pipeline los pone el runner. */
export interface DashboardPanels {
  feed: boolean
  pipeline: boolean
}
