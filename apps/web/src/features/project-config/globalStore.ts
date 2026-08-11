import { fetchProjectConfig } from '@/features/project-config/api'
import type { ProjectConfig } from '@ia-flow/shared'
import { defineStore } from 'pinia'
import { ref } from 'vue'

// Read-only cache of the global scope (project_id IS NULL). Mutations happen
// via the granular per-domain APIs; call `fetch()` afterwards to refresh.
export const useGlobalConfigStore = defineStore('global-config', () => {
  const config = ref<ProjectConfig | null>(null)
  const raw = ref('')
  const loading = ref(false)

  async function fetch() {
    loading.value = true
    try {
      const data = await fetchProjectConfig(undefined, 'global')
      config.value = data.config
      raw.value = data.raw
    } finally {
      loading.value = false
    }
  }

  return { config, raw, loading, fetch }
})
