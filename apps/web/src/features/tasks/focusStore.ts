import type { TaskFocus } from '@ia-flow/shared'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { fetchTaskFocus } from '@/features/tasks/api'

/**
 * El foco del proyecto, cacheado por proyecto.
 *
 * Mismo molde que `dispositionsStore` —y por la misma razón: el endpoint no es
 * barato (por debajo llama a un modelo), así que entrar y salir de Tareas no
 * puede pagarlo dos veces—, pero con un estado más: acá "falló" **se dibuja**.
 *
 * Los cuatro estados de la card salen de tres refs, y ninguno es derivable de
 * otro:
 *
 * | estado    | `loading` | `byProject[id]` | `failed[id]` |
 * | --------- | --------- | --------------- | ------------ |
 * | cargando  | `true`    | —               | —            |
 * | con foco  | `false`   | un `TaskFocus`  | `false`      |
 * | sin foco  | `false`   | `null`          | `false`      |
 * | degradado | `false`   | ausente         | `true`       |
 *
 * `null` (no hay nada que decir, o está apagado) y ausente (no se pudo pedir)
 * tienen que poder distinguirse: el primero no dibuja nada y el segundo dibuja
 * el aviso con su `reintentar`.
 */
export const useFocusStore = defineStore('task-focus', () => {
  const byProject = ref<Record<string, TaskFocus | null>>({})
  const failed = ref<Record<string, boolean>>({})
  const loading = ref<Record<string, boolean>>({})

  /** Las promesas en vuelo. Fuera del `ref` a propósito: no es estado que la
   *  UI mire — para eso está `loading`, que sí lo es. */
  const inFlight = new Map<string, Promise<void>>()

  function focusFor(projectId: string | null): TaskFocus | null {
    return projectId ? (byProject.value[projectId] ?? null) : null
  }
  function isLoaded(projectId: string | null): boolean {
    return !!projectId && projectId in byProject.value
  }
  function hasFailed(projectId: string | null): boolean {
    return !!projectId && failed.value[projectId] === true
  }
  function isLoading(projectId: string | null): boolean {
    return !!projectId && loading.value[projectId] === true
  }

  async function load(projectId: string, refresh: boolean): Promise<void> {
    loading.value = { ...loading.value, [projectId]: true }
    try {
      const next = await fetchTaskFocus(projectId, { refresh })
      byProject.value = { ...byProject.value, [projectId]: next }
      failed.value = { ...failed.value, [projectId]: false }
    } catch {
      // Se marca el fallo y se deja el proyecto SIN entrada: con `null` la
      // card no podría distinguir "no hay nada que decir" de "no se pudo".
      const { [projectId]: _drop, ...rest } = byProject.value
      byProject.value = rest
      failed.value = { ...failed.value, [projectId]: true }
    } finally {
      loading.value = { ...loading.value, [projectId]: false }
    }
  }

  /**
   * Trae el foco. Por default no repite lo ya cargado ni duplica un fetch en
   * vuelo.
   *
   * Con `force` sí, y **no se dedupea contra el fetch en vuelo**: el
   * `reintentar` pide el estado de ahora, y colgarse de una promesa que ya
   * salió devuelve lo que aquélla pidió. Se encadena detrás para que dos
   * toques seguidos no sean dos llamadas simultáneas al modelo.
   */
  async function fetch(projectId: string | null, opts: { force?: boolean } = {}): Promise<void> {
    if (!projectId) return
    const running = inFlight.get(projectId)
    if (!opts.force) {
      if (projectId in byProject.value) return
      if (running) return running
    }
    const p = (running ?? Promise.resolve()).then(() => load(projectId, opts.force === true))
    inFlight.set(projectId, p)
    try {
      await p
    } finally {
      if (inFlight.get(projectId) === p) inFlight.delete(projectId)
    }
  }

  return {
    byProject,
    focusFor,
    isLoaded,
    hasFailed,
    isLoading,
    fetch,
    reset(): void {
      byProject.value = {}
      failed.value = {}
      loading.value = {}
      inFlight.clear()
    },
  }
})
