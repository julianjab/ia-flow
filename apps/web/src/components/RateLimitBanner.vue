<script setup lang="ts">
// Global banner shown while GitHub's rate limit is exhausted for the token
// used by the server. State comes from two sources:
//   · Initial snapshot: GET /api/github/rate-limit (in case the limit was
//     already tripped before this tab connected to the WS).
//   · Live updates: `github:rate-limit` WS events broadcast by the server
//     whenever the state flips.
//
// While limited, the polling loop stops calling GitHub — see
// PollingIssueManager. The banner tells the user why the board looks frozen.

import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useServerEvents } from '../composables/useServerEvents'

interface RateLimitSnapshot {
  limited: boolean
  resource: 'graphql' | 'rest' | null
  resetAt: number | null
  limit: number | null
  remaining: number | null
  message: string | null
}

const snap = ref<RateLimitSnapshot | null>(null)
const now = ref(Math.floor(Date.now() / 1000))
let tickTimer: ReturnType<typeof setInterval> | null = null

useServerEvents((msg) => {
  if (msg.type === 'github:rate-limit') {
    snap.value = msg as unknown as RateLimitSnapshot
  }
})

onMounted(async () => {
  try {
    const res = await fetch('/api/github/rate-limit')
    if (res.ok) snap.value = (await res.json()) as RateLimitSnapshot
  } catch {
    /* banner is best-effort — silent on network errors */
  }
  tickTimer = setInterval(() => {
    now.value = Math.floor(Date.now() / 1000)
  }, 1000)
})

onBeforeUnmount(() => {
  if (tickTimer) clearInterval(tickTimer)
})

const visible = computed(() => {
  if (!snap.value?.limited) return false
  if (snap.value.resetAt && now.value >= snap.value.resetAt) return false
  return true
})

const countdown = computed(() => {
  if (!snap.value?.resetAt) return null
  const secs = snap.value.resetAt - now.value
  if (secs <= 0) return null
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
})
</script>

<template>
  <div v-if="visible" class="rate-limit-banner" role="status">
    <span class="dot" aria-hidden="true" />
    <div class="body">
      <strong>GitHub rate limit alcanzado</strong>
      <span class="detail">
        El polling de issues está pausado ({{ snap?.resource ?? 'graphql' }}).
        <template v-if="countdown">Se reanuda en <b>{{ countdown }}</b>.</template>
        <template v-else>Esperando reset…</template>
      </span>
    </div>
  </div>
</template>

<style scoped>
.rate-limit-banner {
  /* Inline banner (not fixed) so it participates in the layout flow and
     pushes the router view down instead of overlapping titles/toolbars. */
  position: sticky;
  top: 0;
  z-index: 1100;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.55rem 1rem;
  background: var(--yellow-bg);
  color: #78350f;
  border-bottom: 1px solid var(--warn);
  font-size: 0.875rem;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
}
.dot {
  width: 0.6rem;
  height: 0.6rem;
  border-radius: 50%;
  background: var(--warn);
  box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.6);
  animation: pulse 1.6s ease-out infinite;
  flex: 0 0 auto;
}
.body {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  align-items: baseline;
}
.detail {
  opacity: 0.9;
}
@keyframes pulse {
  0% { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.6); }
  100% { box-shadow: 0 0 0 10px rgba(245, 158, 11, 0); }
}
</style>
