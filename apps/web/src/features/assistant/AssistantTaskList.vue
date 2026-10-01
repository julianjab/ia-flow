<script setup lang="ts">
import type { InboxItem } from '@ia-flow/shared';
import { KIND_LABEL } from '@/components/taskLabels';

// Las tareas de las que habla una respuesta, como están AHORA en la bandeja
// (lo calculó el runner, no el modelo: nada en `--ai`, R16). Tocar una la abre
// en la bandeja; una sin pendientes no está en la bandeja, así que abre GitHub.

defineProps<{ items: InboxItem[] }>();
const emit = defineEmits<{ (e: 'open', ref: string): void }>();
</script>

<template>
  <ul class="tl" aria-label="Tareas de esta respuesta">
    <li v-for="item in items" :key="item.ref">
      <a
        v-if="item.group === 'idle'"
        class="tl__row"
        :data-group="item.group"
        :href="item.url"
        target="_blank"
        rel="noopener"
      >
        <span class="tl__meta">
          <span class="tl__kind">{{ KIND_LABEL[item.kind] }}</span>
          <span class="tl__ref mono">{{ item.ref }}</span>
          <span v-if="item.status" class="tl__status mono">{{ item.status }}</span>
          <span class="tl__go" aria-hidden="true">↗</span>
        </span>
        <span class="tl__title">{{ item.title }}</span>
      </a>
      <button
        v-else
        type="button"
        class="tl__row"
        :data-group="item.group"
        :data-test="`open-${item.ref}`"
        @click="emit('open', item.ref)"
      >
        <span class="tl__meta">
          <span v-if="item.group === 'run'" class="live-dot" aria-hidden="true" />
          <span class="tl__kind">{{ KIND_LABEL[item.kind] }}</span>
          <span class="tl__ref mono">{{ item.ref }}</span>
          <span v-if="item.status" class="tl__status mono">{{ item.status }}</span>
          <span class="tl__go" aria-hidden="true">→</span>
        </span>
        <span class="tl__title">{{ item.title }}</span>
        <span class="tl__why">{{ item.why }}</span>
      </button>
    </li>
  </ul>
</template>

<style scoped>
.tl { display: flex; flex-direction: column; gap: 0.35rem; margin: 0; padding: 0; list-style: none; }
/* La misma voz que la tarjeta de la bandeja (borde izquierdo del color del grupo), más compacta. */
.tl__row {
  --c: var(--fg-mute);
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  width: 100%;
  min-height: var(--tap-h);
  padding: 0.45rem 0.65rem;
  border: 1px solid var(--border);
  border-left: 3px solid var(--c);
  border-radius: var(--radius);
  background: var(--panel);
  color: inherit;
  font: inherit;
  text-align: left;
  text-decoration: none;
  cursor: pointer;
}
.tl__row[data-group='need'] { --c: var(--warn); }
.tl__row[data-group='fail'] { --c: var(--danger); }
.tl__row[data-group='run'] { --c: var(--accent); }
.tl__row:hover { background: var(--panel-alt); }
.tl__row:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }

.tl__meta { display: flex; flex-wrap: wrap; align-items: center; gap: 0.1rem 0.5rem; min-width: 0; }
.tl__kind { color: var(--c); font-size: var(--fs-chrome); font-weight: 600; text-transform: uppercase; letter-spacing: var(--tracking-lbl); }
.tl__ref { color: var(--fg); font-size: var(--fs-chrome); }
.tl__status { color: var(--fg-dim); font-size: var(--fs-micro); }
.tl__go { margin-left: auto; color: var(--fg-dim); }
.tl__title { color: var(--fg); font-size: var(--fs-body-sm); font-weight: 600; overflow-wrap: anywhere; }
.tl__why { color: var(--fg-mute); font-size: var(--fs-body-sm); overflow-wrap: anywhere; }
</style>
