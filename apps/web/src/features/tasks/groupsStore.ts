import type { TaskGroups } from '@ia-flow/shared'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { fetchTaskGroups } from '@/features/tasks/api'

/**
 * Los grupos por tema del proyecto, cacheados por proyecto.
 *
 * Mismo molde que `focusStore.ts` — mismos cuatro estados, mismas reglas de
 * dedupe/force — porque es el mismo tipo de dato: un cómputo de Haiku sobre la
 * misma lista, con su propio interruptor y su propio costo.
 *
 * | estado    | `loading` | `byProject[id]`  | `failed[id]` |
 * | --------- | --------- | ---------------- | ------------ |
 * | cargando  | `true`    | —                 | —            |
 * | con grupos| `false`   | un `TaskGroups`   | `false`      |
 * | sin grupos| `false`   | `null`            | `false`      |
 * | degradado | `false`   | ausente           | `true`       |
 */
export const useTaskGroupsStore = defineStore('task-groups', () => {
  const byProject = ref<Record<string, TaskGroups | null>>({})
  const failed = ref<Record<string, boolean>>({})
  const loading = ref<Record<string, boolean>>({})

  const inFlight = new Map<string, Promise<void>>()

  function groupsFor(projectId: string | null): TaskGroups | null {
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
      const next = await fetchTaskGroups(projectId, { refresh })
      byProject.value = { ...byProject.value, [projectId]: next }
      failed.value = { ...failed.value, [projectId]: false }
    } catch {
      const { [projectId]: _drop, ...rest } = byProject.value
      byProject.value = rest
      failed.value = { ...failed.value, [projectId]: true }
    } finally {
      loading.value = { ...loading.value, [projectId]: false }
    }
  }

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
    groupsFor,
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
