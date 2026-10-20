<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import {
  CLIP_TTL_MS,
  fetchClip,
  insertAt,
  isTextField,
  type MacClip,
  macPulseBase,
  readSeen,
  shouldShow,
  writeSeen,
} from './macClipboard'

// La pastilla «📋 de la Mac», arriba y en todas las pantallas (va en App.vue). Mientras la pestaña se ve,
// pregunta cada 4 s (y al volver a ella); escondida no pregunta. Sin sesión de mac-pulse espera 5 min.
const EVERY_MS = 4_000
const NO_SESSION_MS = 5 * 60_000
const ERROR_MS = 30_000

const base = macPulseBase(import.meta.env.VITE_MAC_PULSE_URL, location.hostname)
const clip = ref<MacClip | null>(null)
const seen = ref(readSeen())
const now = ref(Date.now())
const note = ref('')
/** El último campo de texto con foco: «Pegar aquí» pega ahí. */
const field = ref<HTMLInputElement | HTMLTextAreaElement | null>(null)

const visible = computed(() => shouldShow(clip.value, seen.value, now.value))
const preview = computed(() => clip.value?.text.replace(/\s+/g, ' ').trim().slice(0, 80) ?? '')
const canPaste = computed(() => !!field.value?.isConnected)

let timer: ReturnType<typeof setTimeout> | undefined
async function tick() {
  clearTimeout(timer)
  if (!base || document.hidden) return
  const got = await fetchClip(base, clip.value?.id ?? null)
  now.value = Date.now()
  if (got.kind === 'clip') clip.value = got.clip
  const wait = got.kind === 'no-session' ? NO_SESSION_MS : got.kind === 'error' ? ERROR_MS : EVERY_MS
  timer = setTimeout(tick, wait)
}

function done() {
  if (clip.value) writeSeen(clip.value.id)
  seen.value = clip.value?.id ?? null
}

async function copy() {
  if (!clip.value) return
  try {
    await navigator.clipboard.writeText(clip.value.text)
    done()
  } catch {
    note.value = 'El navegador no dejó copiar'
    setTimeout(() => (note.value = ''), 2500)
  }
}

function paste() {
  if (!clip.value || !field.value?.isConnected) return
  insertAt(field.value, clip.value.text)
  done()
}

function onFocusIn(e: FocusEvent) {
  if (isTextField(e.target)) field.value = e.target
}
const onVisibility = () => void tick()
// la pastilla se va sola a los 10 min aunque no llegue nada nuevo
const ttl = setInterval(() => (now.value = Date.now()), CLIP_TTL_MS / 10)

onMounted(() => {
  if (!base) return
  document.addEventListener('focusin', onFocusIn)
  document.addEventListener('visibilitychange', onVisibility)
  void tick()
})
onUnmounted(() => {
  clearTimeout(timer)
  clearInterval(ttl)
  document.removeEventListener('focusin', onFocusIn)
  document.removeEventListener('visibilitychange', onVisibility)
})
</script>

<template>
  <div v-if="visible" class="mac-clip" role="status">
    <span class="mac-clip__txt"
      ><b>📋 de la Mac</b> <span class="mono">{{ note || preview }}</span></span
    >
    <!-- pointerdown.prevent: el campo no pierde el foco (ni el teclado del teléfono se cierra) al tocar -->
    <button v-if="canPaste" type="button" class="btn" @pointerdown.prevent @click="paste">Pegar aquí</button>
    <button type="button" class="btn btn--primary" @click="copy">Copiar</button>
    <button type="button" class="mac-clip__x" aria-label="Descartar" @click="done">✕</button>
  </div>
</template>

<style scoped>
.mac-clip {
  position: fixed;
  top: calc(env(safe-area-inset-top, 0px) + var(--tap-h) + 0.5rem);
  left: 50%;
  transform: translateX(-50%);
  z-index: 45;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  width: max-content;
  max-width: calc(100vw - 2rem);
  padding: 0.3rem 0.3rem 0.3rem 0.75rem;
  border: 1px solid var(--border-hi);
  border-radius: var(--radius);
  background: var(--panel-hi);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  font-size: var(--fs-body-sm);
}
.mac-clip__txt {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--fg-dim);
}
.mac-clip__txt b { margin-right: 0.3rem; color: var(--fg); font-weight: 600; }
.mac-clip .btn { flex: none; }
.mac-clip__x {
  flex: none;
  width: var(--tap-h-sm);
  height: var(--tap-h-sm);
  border: 0;
  background: none;
  color: var(--fg-dim);
  cursor: pointer;
}
.mac-clip__x:hover { color: var(--fg); }
</style>
