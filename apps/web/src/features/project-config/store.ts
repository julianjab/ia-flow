import { fetchProjectConfig } from '@/features/project-config/api'
import { useProjectsStore } from '@/features/projects/store'
import type { ProjectConfig } from '@ia-flow/shared'
import { defineStore } from 'pinia'
import { ref } from 'vue'

// Read-only cache of the project-scoped overlay view. Mutations happen via the
// granular per-domain APIs; call `fetch()` afterwards to refresh.
export const useProjectConfigStore = defineStore('project-config', () => {
  const config = ref<ProjectConfig | null>(null)
  const raw = ref('')
  const loading = ref(false)

  function currentProjectId(): string | undefined {
    return useProjectsStore().activeProjectId ?? undefined
  }

  async function fetch() {
    loading.value = true
    try {
      const data = await fetchProjectConfig(currentProjectId())
      config.value = data.config
      raw.value = data.raw
    } finally {
      loading.value = false
    }
  }

  return { config, raw, loading, fetch }
})
