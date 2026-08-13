// Global cache of in-flight executions. Powers the topbar chip ("N corriendo"),
// the dashboard, and per-project active badges. Hydrates from
// GET /api/executions/active and stays in sync via the shared WS stream —
// execution:started adds/updates a row, execution:updated removes it once
// finishedAt is populated.

import { fetchActiveExecutions } from '@/features/executions/api'
import { type ExecutionLog, ExecutionLogSchema } from '@ia-flow/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

export const useActiveExecutionsStore = defineStore('active-executions', () => {
  const executions = ref<ExecutionLog[]>([])
  const loading = ref(false)
  const loaded = ref(false)
  const error = ref<string | null>(null)

  const activeCount = computed(() => executions.value.length)

  const byProject = computed<Record<string, ExecutionLog[]>>(() => {
    const map: Record<string, ExecutionLog[]> = {}
    for (const e of executions.value) {
      if (!map[e.projectId]) map[e.projectId] = []
      map[e.projectId].push(e)
    }
    return map
  })

  function countForProject(projectId: string): number {
    return byProject.value[projectId]?.length ?? 0
  }

  async function fetch(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      executions.value = await fetchActiveExecutions()
      loaded.value = true
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      loading.value = false
    }
  }

  // Feed WS payloads through here — schema parse guards against a bad
  // broadcast; callers don't need to know the payload shape.
  function ingest(raw: unknown, type: 'execution:started' | 'execution:updated'): void {
    const parsed = ExecutionLogSchema.safeParse(raw)
    if (!parsed.success) return
    const log = parsed.data
    const idx = executions.value.findIndex((e) => e.id === log.id)
    if (log.finishedAt) {
      if (idx !== -1) executions.value = executions.value.filter((e) => e.id !== log.id)
      return
    }
    if (type === 'execution:started' && idx === -1) {
      executions.value = [log, ...executions.value]
    } else if (idx !== -1) {
      executions.value = executions.value.map((e) => (e.id === log.id ? log : e))
    } else {
      executions.value = [log, ...executions.value]
    }
  }

  return {
    executions,
    loading,
    loaded,
    error,
    activeCount,
    byProject,
    countForProject,
    fetch,
    ingest,
  }
})
