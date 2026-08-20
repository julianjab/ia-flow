// Global cache of the GitHub rate-limit snapshot for the server's token.
// Powers the topbar chip and the exhausted-limit banner without each
// component opening its own fetch/WS subscription — mirrors
// features/executions/activeStore.ts.

import { type RateLimitSnapshot, getRateLimit } from '@/features/github/api'
import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useRateLimitStore = defineStore('github-rate-limit', () => {
  const snapshot = ref<RateLimitSnapshot | null>(null)
  const loaded = ref(false)

  async function fetch(): Promise<void> {
    try {
      snapshot.value = await getRateLimit()
    } catch {
      /* best-effort — silent on network errors, WS still keeps it live */
    } finally {
      loaded.value = true
    }
  }

  function ingest(raw: unknown): void {
    snapshot.value = raw as RateLimitSnapshot
  }

  return { snapshot, loaded, fetch, ingest }
})
