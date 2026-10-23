import type { RepoIssues } from '@ia-flow/shared'
import { ref } from 'vue'
import { extractErrorMessage } from '@/composables/extractErrorMessage'
import { getRepoIssues } from '@/features/inbox/api'

// Los issues de los repos del catálogo del runner que todavía no tienen card: el final de «Próximo»,
// para que nada de lo que el runner maneja quede fuera de la vista. Vive dentro del store
// (`store.ts` la compone); `null` con un runner que no lo publica.

export function createRepoIssues(project: () => string | null) {
  const repoIssues = ref<RepoIssues | null>(null)
  const repoIssuesLoading = ref(false)
  const repoIssuesError = ref<string | null>(null)

  async function loadRepoIssues(): Promise<void> {
    repoIssuesLoading.value = true
    try {
      repoIssues.value = await getRepoIssues(project() ?? undefined)
      repoIssuesError.value = null
    } catch (err) {
      repoIssuesError.value = extractErrorMessage(err)
    } finally {
      repoIssuesLoading.value = false
    }
  }

  return { repoIssues, repoIssuesLoading, repoIssuesError, loadRepoIssues }
}
