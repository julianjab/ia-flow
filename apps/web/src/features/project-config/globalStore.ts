import {
  fetchProjectConfig,
  saveProjectConfig,
  saveProjectConfigRaw,
} from '@/features/project-config/api'
import type { ProjectConfig } from '@ia-flow/shared'
import { defineStore } from 'pinia'
import { ref } from 'vue'

// Mirror of useProjectConfigStore but pinned to the global scope (project_id
// IS NULL). Used by the "General" section of the settings UI where users
// manage agents and system prompts that live outside any single project.
export const useGlobalConfigStore = defineStore('global-config', () => {
  const config = ref<ProjectConfig | null>(null)
  const raw = ref('')
  const loading = ref(false)
  const saving = ref(false)

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

  async function save(updated: ProjectConfig) {
    saving.value = true
    try {
      await saveProjectConfig(updated, undefined, 'global')
      await fetch()
    } finally {
      saving.value = false
    }
  }

  async function saveRaw(yaml: string) {
    saving.value = true
    try {
      await saveProjectConfigRaw(yaml, undefined, 'global')
      await fetch()
    } finally {
      saving.value = false
    }
  }

  return { config, raw, loading, saving, fetch, save, saveRaw }
})
