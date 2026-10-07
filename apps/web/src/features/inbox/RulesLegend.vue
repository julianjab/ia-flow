<script setup lang="ts">
import { computed } from 'vue';
import DashboardEditor from '@/features/inbox/DashboardEditor.vue';
import Disclosure from '@/features/inbox/Disclosure.vue';
import { GROUP_LABEL, LEGEND, LEGEND_HIDDEN } from '@/features/inbox/labels';
import { useInboxStore } from '@/features/inbox/store';

// «Cómo se ordenan las decisiones»: la respuesta a "¿por qué está esto acá?" sin salir
// de la pantalla. Plegada por defecto — se lee una vez, no en cada visita. Con un runner que
// publica los hechos, las reglas son las del dashboard de ese runner —en el orden en que se
// evalúan— y desde acá se edita; con uno viejo, las que clasifica él. El tono va por TIPO en la
// cola, no por grupo: acá los nombres van neutros.

const store = useInboxStore();
const decisions = computed(() => store.dashboard?.dashboard.decisions ?? null);
</script>

<template>
  <Disclosure title="Cómo se ordenan las decisiones" class="lg">
    <dl v-if="decisions" class="lg__body">
      <template v-for="decision in decisions" :key="decision.id">
        <dt class="lg__group">{{ decision.verb ?? decision.id }}</dt>
        <dd class="lg__rules">
          <p>{{ GROUP_LABEL[decision.group] }} · {{ decision.why }}</p>
          <p v-if="decision.weight" class="lg__order">peso {{ decision.weight }}</p>
        </dd>
      </template>
      <dt class="lg__group">Orden</dt>
      <dd class="lg__rules"><p>{{ store.dashboard?.dashboard.rank.join(' → ') }}</p></dd>
    </dl>
    <dl v-else class="lg__body">
      <template v-for="entry in LEGEND" :key="entry.group">
        <dt class="lg__group">{{ GROUP_LABEL[entry.group] }}</dt>
        <dd class="lg__rules">
          <p v-for="rule in entry.rules" :key="rule">{{ rule }}</p>
          <p v-if="entry.order" class="lg__order">{{ entry.order }}</p>
        </dd>
      </template>
      <dt class="lg__group">No se muestra</dt>
      <dd class="lg__rules"><p>{{ LEGEND_HIDDEN }}</p></dd>
    </dl>
    <div v-if="decisions" class="lg__edit"><DashboardEditor /></div>
  </Disclosure>
</template>

<style scoped>
.lg__body { margin: 0; padding: 0 0.75rem 0.5rem; display: grid; gap: 0; }
.lg__group { padding-top: 0.6rem; color: var(--fg-mute); font-weight: 600; font-size: var(--fs-body-sm); }
.lg__rules { margin: 0; padding: 0.25rem 0 0.6rem; border-bottom: 1px solid var(--border-mute); color: var(--fg-mute); font-size: var(--fs-body-sm); line-height: 1.5; }
.lg__rules p { margin: 0 0 0.25rem; }
.lg__order { color: var(--fg-dim); }
.lg__edit { padding: 0 0.75rem; border-top: 1px solid var(--border-mute); }
/* R5: la etiqueta va arriba bajo 640; al lado desde ahí. */
@media (min-width: 640px) {
  .lg__body { grid-template-columns: 9rem 1fr; column-gap: 1rem; }
  .lg__group { border-bottom: 1px solid var(--border-mute); }
}
</style>
