import { fetchTaskDispositions } from '@/features/tasks/api'
import type { TaskDispositionEntry } from '@ia-flow/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

/**
 * Las disposiciones del proyecto, cacheadas por proyecto.
 *
 * Existe por el badge de la tab bar (turno 8: `TAREAS 45` en `--danger`), que
 * necesita el mismo dato que la pantalla de Tareas ya pedía. Sin un lugar
 * compartido serían **dos** requests a `GET /api/tasks/dispositions` cada vez
 * que se entra a Tareas — y ése no es un endpoint barato: por debajo hace
 * `getItems()` contra la fuente más los blockers de cada ítem, o sea rate
 * limit de GitHub.
 *
 * Cachea por `projectId` y no globalmente porque cambiar de proyecto no
 * invalida lo del anterior: volver es gratis.
 */
export const useDispositionsStore = defineStore('task-dispositions', () => {
  const byProject = ref<Record<string, TaskDispositionEntry[]>>({})
  /** El agregado no se pudo consultar. Es distinto de "vacío": la lista cae al
   *  orden de la fuente y lo DICE, en vez de agrupar por buckets que no
   *  conoce. */
  const failed = ref<Record<string, boolean>>({})
  /**
   * Las promesas en vuelo, por proyecto.
   *
   * Sin esto, la tab bar y la pantalla de Tareas montando a la vez disparan
   * dos veces el mismo fetch — que es exactamente lo que este store viene a
   * evitar. Fuera del `ref` a propósito: no es estado que la UI mire.
   */
  const inFlight = new Map<string, Promise<void>>()

  function entriesFor(projectId: string | null): TaskDispositionEntry[] {
    return projectId ? (byProject.value[projectId] ?? []) : []
  }

  /** `false` mientras no se sabe. Un badge que cuenta cero sobre un dato que
   *  no llegó afirma "no te espera nada", que es lo contrario de no saber. */
  function isLoaded(projectId: string | null): boolean {
    return !!projectId && projectId in byProject.value
  }

  function hasFailed(projectId: string | null): boolean {
    return !!projectId && failed.value[projectId] === true
  }

  /** Lo que te espera, que es lo único que el badge cuenta. */
  function waitingCount(projectId: string | null): number {
    return entriesFor(projectId).filter((d) => d.disposition === 'waiting-on-you').length
  }

  /**
   * Trae las disposiciones del proyecto.
   *
   * Por default NO refetchea lo ya cargado: el consumidor que quiere datos
   * frescos (el `↺` de Tareas, un evento del socket) pasa `force`.
   */
  async function fetch(projectId: string | null, opts: { force?: boolean } = {}): Promise<void> {
    if (!projectId) return
    if (!opts.force && projectId in byProject.value) return
    const running = inFlight.get(projectId)
    if (running) return running

    const p = (async () => {
      try {
        const next = await fetchTaskDispositions(projectId)
        byProject.value = { ...byProject.value, [projectId]: next }
        failed.value = { ...failed.value, [projectId]: false }
      } catch {
        // Se marca el fallo y se deja el proyecto SIN entrada: con `[]` la
        // pantalla no podría distinguir "no hay tareas" de "no se pudo pedir".
        failed.value = { ...failed.value, [projectId]: true }
      } finally {
        inFlight.delete(projectId)
      }
    })()
    inFlight.set(projectId, p)
    return p
  }

  return {
    byProject,
    entriesFor,
    isLoaded,
    hasFailed,
    waitingCount,
    fetch,
    /** Para los tests, y para un reset explícito al cambiar de server. */
    reset(): void {
      byProject.value = {}
      failed.value = {}
      inFlight.clear()
    },
    loadedProjects: computed(() => Object.keys(byProject.value)),
  }
})
