import type { TaskDispositionEntry } from '@ia-flow/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { fetchTaskDispositions } from '@/features/tasks/api'

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

  /** El request en sí. `fetch` decide CUÁNDO; esto sólo lo hace. */
  async function load(projectId: string): Promise<void> {
    try {
      const next = await fetchTaskDispositions(projectId)
      byProject.value = { ...byProject.value, [projectId]: next }
      failed.value = { ...failed.value, [projectId]: false }
    } catch {
      // Se marca el fallo y se deja el proyecto SIN entrada: con `[]` la
      // pantalla no podría distinguir "no hay tareas" de "no se pudo pedir".
      failed.value = { ...failed.value, [projectId]: true }
    }
  }

  /**
   * Trae las disposiciones del proyecto.
   *
   * Por default NO refetchea lo ya cargado ni duplica un fetch en vuelo: es lo
   * que hace que la tab bar y la pantalla de Tareas montando a la vez paguen
   * un solo request.
   *
   * Con `force` sí refetchea, y **no se dedupea contra el fetch en vuelo**: el
   * `↺` pide el estado de AHORA, y colgarse de una promesa que ya salió
   * devuelve lo que aquélla pidió — el operador toca refrescar y no pasa nada.
   * Se encadena detrás en vez de correr en paralelo, así dos toques seguidos
   * no son dos requests simultáneos contra la fuente.
   */
  async function fetch(projectId: string | null, opts: { force?: boolean } = {}): Promise<void> {
    if (!projectId) return
    const running = inFlight.get(projectId)
    if (!opts.force) {
      if (projectId in byProject.value) return
      if (running) return running
    }

    const p = (running ?? Promise.resolve()).then(() => load(projectId))
    inFlight.set(projectId, p)
    try {
      await p
    } finally {
      // Sólo si sigue siendo la última: un `force` que entró mientras ésta
      // corría ya dejó la suya, y borrarla haría que el próximo consumidor
      // creyera que no hay nada en vuelo.
      if (inFlight.get(projectId) === p) inFlight.delete(projectId)
    }
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
