import {
  fetchProjectConfig,
  saveProjectConfig,
  saveProjectConfigRaw,
} from '@/features/project-config/api'
import { useProjectsStore } from '@/features/projects/store'
import type { ProjectConfig } from '@ia-flow/shared'
import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useProjectConfigStore = defineStore('project-config', () => {
  const config = ref<ProjectConfig | null>(null)
  const raw = ref('')
  const loading = ref(false)
  const saving = ref(false)

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

  async function save(updated: ProjectConfig) {
    saving.value = true
    try {
      await saveProjectConfig(updated, currentProjectId())
      await fetch()
    } finally {
      saving.value = false
    }
  }

  async function saveRaw(yaml: string) {
    saving.value = true
    try {
      await saveProjectConfigRaw(yaml, currentProjectId())
      await fetch()
    } finally {
      saving.value = false
    }
  }

  return { config, raw, loading, saving, fetch, save, saveRaw }
})
