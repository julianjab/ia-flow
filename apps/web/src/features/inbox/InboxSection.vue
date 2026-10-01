<script setup lang="ts">
import type { InboxGroup, InboxItem } from '@ia-flow/shared';
import { GROUP_HINT, GROUP_LABEL } from '@/features/inbox/labels';
import InboxCard from '@/features/inbox/InboxCard.vue';
import type { DetailState } from '@/features/inbox/store';

// Un grupo de la bandeja: encabezado (nombre · cuántas · para qué sirve) y sus
// tarjetas. El orden lo trae el runner ya decidido: acá no se reordena nada.

defineProps<{
  group: InboxGroup;
  items: InboxItem[];
  openRef: string | null;
  details: Record<string, DetailState>;
}>();

const emit = defineEmits<{ (e: 'toggle', ref: string): void; (e: 'reload', ref: string): void }>();
</script>

<template>
  <section class="sec" :data-group="group" :aria-labelledby="`sec-${group}`">
    <h2 :id="`sec-${group}`" class="sec__hd">
      {{ GROUP_LABEL[group] }}
      <span v-if="items.length" class="sec__n mono">{{ items.length }}</span>
      <span class="sec__hint">{{ GROUP_HINT[group] }}</span>
    </h2>

    <div v-if="items.length" class="sec__list">
      <InboxCard
        v-for="item in items"
        :key="item.ref"
        :item="item"
        :open="openRef === item.ref"
        :detail="details[item.ref]"
        @toggle="emit('toggle', $event)"
        @reload="emit('reload', $event)"
      />
    </div>
    <p v-else class="sec__empty">Nada por acá.</p>
  </section>
</template>

<style scoped>
.sec { min-width: 0; }
.sec__hd {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.15rem 0.6rem;
  margin: 0 0 0.5rem;
  font-size: var(--fs-body);
  text-transform: uppercase;
  letter-spacing: var(--tracking-hd);
  color: var(--fg-mute);
}
.sec[data-group='need'] .sec__hd { color: var(--warn); }
.sec[data-group='fail'] .sec__hd { color: var(--danger); }
.sec[data-group='run'] .sec__hd { color: var(--accent); }
.sec__n { font-size: var(--fs-chrome); font-weight: 500; }
.sec__hint { margin-left: auto; font-family: var(--font-body); font-size: var(--fs-chrome); font-weight: 400; text-transform: none; letter-spacing: 0; color: var(--fg-dim); }
.sec__list { display: flex; flex-direction: column; gap: 0.5rem; }
.sec__empty { margin: 0; padding: 0.75rem; border: 1px dashed var(--border); border-radius: var(--radius); color: var(--fg-dim); font-size: var(--fs-body-sm); }
</style>
