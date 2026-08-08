import { archiveProject, createProject, fetchProjects, patchProject } from '@/features/projects/api'
import type { Project } from '@ia-flow/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

const ACTIVE_PROJECT_STORAGE_KEY = 'ia-flow:active-project-id'

function readStoredActiveId(): string | null {
  if (typeof localStorage === 'undefined') return null
  try {
    return localStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY)
  } catch {
    return null
  }
}

function persistActiveId(id: string | null): void {
  if (typeof localStorage === 'undefined') return
  try {
    if (id === null) localStorage.removeItem(ACTIVE_PROJECT_STORAGE_KEY)
    else localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, id)
  } catch {
    /* localStorage unavailable — ignore */
  }
}

export const useProjectsStore = defineStore('projects', () => {
  const projects = ref<Project[]>([])
  const activeProjectId = ref<string | null>(readStoredActiveId())
  const loading = ref(false)
  const saving = ref(false)
  const error = ref<string | null>(null)

  const activeProject = computed<Project | null>(
    () => projects.value.find((p: Project) => p.id === activeProjectId.value) ?? null,
  )

  function setActiveProjectId(id: string | null): void {
    activeProjectId.value = id
    persistActiveId(id)
  }

  async function fetch(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      projects.value = await fetchProjects()
      // Fall back to the first project if the stored one is gone (archived / renamed).
      if (!projects.value.some((p: Project) => p.id === activeProjectId.value)) {
        setActiveProjectId(projects.value[0]?.id ?? null)
      }
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      throw e
    } finally {
      loading.value = false
    }
  }

  async function create(input: {
    id: string
    name: string
    githubProjectUrl?: string | null
  }): Promise<Project> {
    saving.value = true
    try {
      const project = await createProject(input)
      await fetch()
      setActiveProjectId(project.id)
      return project
    } finally {
      saving.value = false
    }
  }

  async function update(
    id: string,
    patch: { name?: string; githubProjectUrl?: string | null },
  ): Promise<Project> {
    saving.value = true
    try {
      const project = await patchProject(id, patch)
      await fetch()
      return project
    } finally {
      saving.value = false
    }
  }

  async function archive(id: string): Promise<void> {
    saving.value = true
    try {
      await archiveProject(id)
      await fetch()
    } finally {
      saving.value = false
    }
  }

  return {
    projects,
    activeProjectId,
    activeProject,
    loading,
    saving,
    error,
    setActiveProjectId,
    fetch,
    create,
    update,
    archive,
  }
})
