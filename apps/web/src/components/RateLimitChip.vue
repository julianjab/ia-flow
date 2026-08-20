<script setup lang="ts">
import { useRateLimitStore } from '@/features/github/store'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

const store = useRateLimitStore()

const open = ref(false)
const chipRoot = ref<HTMLElement | null>(null)
const now = ref(Math.floor(Date.now() / 1000))
let tickTimer: ReturnType<typeof setInterval> | null = null

function toggle() { open.value = !open.value }

function onDocClick(e: MouseEvent) {
  if (!open.value) return
  if (chipRoot.value && !chipRoot.value.contains(e.target as Node)) {
    open.value = false
  }
}
onMounted(() => {
  document.addEventListener('mousedown', onDocClick)
  tickTimer = setInterval(() => {
    now.value = Math.floor(Date.now() / 1000)
  }, 1000)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocClick)
  if (tickTimer) clearInterval(tickTimer)
})

const ratio = computed(() => {
  const s = store.snapshot
  if (!s || s.limit === null || s.remaining === null || s.limit === 0) return null
  return s.remaining / s.limit
})

// low: <10% left (warn), exhausted: rate-limited (bad) — mirrors RateLimitBanner's threshold.
const status = computed<'ok' | 'low' | 'limited'>(() => {
  if (store.snapshot?.limited) return 'limited'
  if (ratio.value !== null && ratio.value <= 0.1) return 'low'
  return 'ok'
})

const resetIn = computed(() => {
  const resetAt = store.snapshot?.resetAt
  if (!resetAt) return null
  const secs = resetAt - now.value
  if (secs <= 0) return null
  const m = Math.floor(secs / 60)
  return m > 0 ? `${m}m` : `${secs}s`
})
</script>

<template>
  <div ref="chipRoot" class="chip-root">
    <button
      type="button"
      class="chip"
      :class="[`chip--${status}`]"
      :aria-expanded="open"
      title="Cupo de requests a la API de GitHub"
      @click="toggle"
    >
      <span class="chip__glyph">◆</span>
      <span v-if="store.snapshot?.remaining !== null && store.snapshot?.remaining !== undefined" class="chip__count">
        {{ store.snapshot.remaining }}<span class="chip__sep">/</span>{{ store.snapshot.limit }}
      </span>
      <span v-else class="chip__count">—</span>
      <span class="chip__label">gh api</span>
    </button>

    <div v-if="open" class="popover" role="dialog" aria-label="Rate limit de GitHub">
      <div class="popover__header">GITHUB API RATE LIMIT</div>
      <div v-if="store.snapshot" class="popover__body">
        <div class="popover__row">
          <span class="popover__key">resource</span>
          <span class="popover__val">{{ store.snapshot.resource ?? '—' }}</span>
        </div>
        <div class="popover__row">
          <span class="popover__key">remaining</span>
          <span class="popover__val">{{ store.snapshot.remaining ?? '—' }} / {{ store.snapshot.limit ?? '—' }}</span>
        </div>
        <div v-if="resetIn" class="popover__row">
          <span class="popover__key">reset en</span>
          <span class="popover__val">{{ resetIn }}</span>
        </div>
        <div v-if="store.snapshot.limited" class="popover__warn">
          Límite alcanzado — el polling de issues está pausado.
        </div>
      </div>
      <div v-else class="popover__empty">· sin datos aún</div>
    </div>
  </div>
</template>

<style scoped>
.chip-root { position: relative; }

.chip {
  display: inline-flex;
  align-items: center;
  gap: 0.5ch;
  height: 20px;
  padding: 0 0.75rem;
  background: transparent;
  border: 1px solid var(--border);
  color: var(--fg-dim);
  font: 500 var(--fs-chrome)/1 var(--font-mono);
  cursor: pointer;
}
.chip:hover { border-color: var(--border-hi); color: var(--fg); }

.chip--low {
  color: var(--warn);
  border-color: var(--warn);
}
.chip--limited {
  color: var(--warn);
  border-color: var(--warn);
  box-shadow: 0 0 12px -6px var(--warn);
}
.chip--limited .chip__glyph { animation: blink 1.6s ease-in-out infinite; }

.chip__glyph { color: var(--cyan); }
.chip--low .chip__glyph,
.chip--limited .chip__glyph { color: var(--warn); }
.chip__count { color: var(--fg); font-weight: 700; }
.chip__sep { color: var(--fg-dimmer); font-weight: 400; }
.chip__label { color: inherit; }

.popover {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  min-width: 240px;
  background: var(--panel);
  border: 1px solid var(--border);
  z-index: 100;
  overflow: hidden;
  font-family: var(--font-mono);
}
.popover__header {
  padding: 0.35rem 0.75rem;
  background: var(--panel-hi);
  border-bottom: 1px solid var(--border);
  font-size: var(--fs-chrome);
  letter-spacing: var(--tracking-hd);
  color: var(--fg);
}
.popover__body { padding: 0.5rem 0.75rem; display: flex; flex-direction: column; gap: 0.25rem; }
.popover__row {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
  font-size: var(--fs-body-sm);
}
.popover__key { color: var(--fg-dimmer); }
.popover__val { color: var(--fg); }
.popover__warn {
  margin-top: 0.25rem;
  color: var(--warn);
  font-size: var(--fs-body-sm);
}
.popover__empty {
  padding: 0.75rem;
  color: var(--fg-dimmer);
  font-size: var(--fs-body-sm);
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}
</style>
