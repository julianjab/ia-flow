import { onMounted, type Ref, ref, watch } from 'vue'
import { extractErrorMessage } from '@/composables/extractErrorMessage'
import { type ExecutionStats, fetchExecutionStats } from './api'

/**
 * Las stats de la ventana activa (7d/30d), compartidas entre `HealthVerdict`
 * (la línea de salud y el costo del período, arriba de todo) y los
 * `quickFilters` de `ListControlsBar` (los contadores rápidos, pegados al
 * filtro, cableados en `ExecutionsSection.vue`). Los dos vivían en un solo
 * componente — separarlos en el layout sin este composable hubiera
 * significado el mismo `fetchExecutionStats` dos veces.
 */
export function useExecutionHealthStats(projectId: Ref<string | null>) {
  const windowDays = ref<number>(7)
  const stats = ref<ExecutionStats | null>(null)
  const loading = ref(false)
  const error = ref('')

  async function load(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      const from = new Date(Date.now() - windowDays.value * 24 * 60 * 60 * 1000).toISOString()
      stats.value = await fetchExecutionStats({
        from,
        ...(projectId.value ? { projectId: projectId.value } : {}),
      })
    } catch (err) {
      error.value = extractErrorMessage(err)
      stats.value = null
    } finally {
      loading.value = false
    }
  }

  onMounted(load)
  watch([projectId, windowDays], load)

  return { windowDays, stats, loading, error }
}
