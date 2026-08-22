<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { FALLBACK_META, loadProjectsMeta } from '@/features/projects/meta';

// Editor para `project.settings.daemonMode` — cómo el daemon se entera de que
// hay trabajo en el proyecto. No es parte de SourceRef: la fuente dice de
// dónde se leen los items, esto dice cuándo se los vuelve a mirar.
// Resolución server-side (dispatch/daemon-mode.ts): setting del proyecto →
// IA_FLOW_DAEMON_MODE → 'webhook'. Vacío = heredar, y por eso emitimos null
// (no undefined): PATCH /api/projects/:id mergea settings por key, así que
// undefined dejaría el valor viejo en la DB.
const props = defineProps<{ modelValue: string | null | undefined }>();
const emit = defineEmits<{ 'update:modelValue': [value: string | null] }>();

const modes = ref<string[]>([...FALLBACK_META.daemonModes]);
const fallback = ref<string>(FALLBACK_META.daemonModeFallback);

onMounted(async () => {
  const meta = await loadProjectsMeta();
  modes.value = meta.daemonModes;
  fallback.value = meta.daemonModeFallback;
});

const selected = computed({
  get: () => props.modelValue ?? '',
  set: (v: string) => emit('update:modelValue', v === '' ? null : v),
});

const effective = computed(() => props.modelValue || fallback.value);

const DESCRIPTIONS: Record<string, string> = {
  webhook: 'GitHub empuja cada evento a /api/webhooks/github y dispara un ciclo.',
  polling: 'Pull periódico cada IA_FLOW_POLL_INTERVAL_MS (30s por default).',
};
</script>

<template>
  <div class="dmf">
    <label class="dmf-field">
      <span class="dmf-label">Modo de disparo</span>
      <select v-model="selected" class="dmf-select">
        <option value="">Heredar ({{ fallback }})</option>
        <option v-for="m in modes" :key="m" :value="m">{{ m }}</option>
      </select>
    </label>
    <span class="dmf-hint">
      Efectivo: <strong>{{ effective }}</strong>. {{ DESCRIPTIONS[effective] ?? '' }}
    </span>
  </div>
</template>

<style scoped>
.dmf { display: flex; flex-direction: column; gap: 0.35rem; }
.dmf-field { display: flex; flex-direction: column; gap: 0.35rem; }
.dmf-label { font-size: 0.85rem; color: var(--fg-mute); font-weight: 500; }
.dmf-hint { font-size: 0.75rem; color: var(--fg-dim); }
.dmf-select {
  padding: 0.5rem 0.65rem;
  border: 1px solid var(--border-hi);
  font-size: 0.9rem;
  background: var(--panel);
}
</style>
