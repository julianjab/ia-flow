<script setup lang="ts">
import type { SlackMemberRef } from '@ia-flow/shared';
import { computed, ref } from 'vue';
import SlackChannelField from './SlackChannelField.vue';
import SlackMemberMultiSelect from './SlackMemberMultiSelect.vue';

// Canal + reviewers, colapsados detrás de una fila con resumen.
//
// Colapsable porque en el editor de repos es config OPCIONAL —vacío hereda del
// proyecto— y desplegada empujaba abajo lo que casi siempre se viene a editar
// (path, repo de GitHub, workflow). El resumen de la fila cerrada dice si el
// repo overridea algo sin tener que abrirla.
//
// Vive en `ui/` porque lo comparten el editor inline y el modal de repos, y la
// misma caja se reusa arriba del listado de tareas.

const props = defineProps<{
  channel: string;
  reviewers: SlackMemberRef[];
  /** Qué se hereda cuando estos campos quedan vacíos. */
  inheritLabel?: string;
}>();

const emit = defineEmits<{
  (e: 'update:channel', value: string): void;
  (e: 'update:reviewers', value: SlackMemberRef[]): void;
}>();

const open = ref(false);

const summary = computed(() => {
  const parts: string[] = [];
  if (props.channel.trim()) parts.push(props.channel.trim());
  if (props.reviewers.length) parts.push(`${props.reviewers.length} reviewer(s)`);
  return parts.length ? parts.join(' · ') : (props.inheritLabel ?? 'hereda del proyecto');
});

const inherits = computed(() => !props.channel.trim() || !props.reviewers.length);
</script>

<template>
  <div class="srf">
    <button type="button" class="srf-head" :aria-expanded="open" @click="open = !open">
      <span class="srf-glyph">{{ open ? '▾' : '▸' }}</span>
      <span class="uc-label">Review en Slack</span>
      <span class="srf-summary" :class="{ 'is-inherited': inherits }">{{ summary }}</span>
    </button>

    <div v-if="open" class="srf-body">
      <div class="srf-field">
        <label class="uc-label">Canal</label>
        <SlackChannelField
          :model-value="channel"
          @update:model-value="emit('update:channel', $event)"
        />
      </div>

      <div class="srf-field">
        <label class="uc-label">Reviewers</label>
        <SlackMemberMultiSelect
          :model-value="reviewers"
          @update:model-value="emit('update:reviewers', $event)"
        />
      </div>

      <p class="srf-hint">
        Vacío hereda {{ inheritLabel ?? 'del proyecto' }}. Cada campo cae por separado.
      </p>
    </div>
  </div>
</template>

<style scoped>
.srf {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel);
}
.srf-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0 0.5rem;
  line-height: calc(var(--row-h) * 1.3);
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
  color: var(--fg);
}
.srf-head:hover { background: var(--panel-hi); }
.srf-glyph { flex: 0 0 auto; color: var(--fg-dim); font-size: var(--fs-micro); }
.srf-summary {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--info);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.srf-summary.is-inherited { color: var(--fg-dimmer); }

.srf-body {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.5rem;
  border-top: 1px solid var(--border-mute);
}
.srf-field { display: flex; flex-direction: column; gap: 0.25rem; }
.srf-hint { margin: 0; color: var(--fg-dimmer); font-size: var(--fs-micro); }
</style>
