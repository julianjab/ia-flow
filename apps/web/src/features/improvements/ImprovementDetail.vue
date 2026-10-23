<script setup lang="ts">
import type { ImprovementProposal } from '@ia-flow/shared';
import { computed, onMounted } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { useAssistantStore } from '@/stores/assistant';
import ImprovementCard from './ImprovementCard.vue';
import { useImprovementsStore } from './store';
import { WHY_QUESTIONS, whyContext, whyScope } from './why';

// Una mejora en su pantalla (v5, como el detalle de una tarea): la ruta de vuelta a «Mejoras» y la
// card entera —dónde se arregla, el porqué, el issue, la columna— con sus acciones. Abrirla o
// descartarla vuelve a la lista; «¿Por qué?» abre el asistente con la mejora como contexto.

const props = defineProps<{ id: string }>();
const emit = defineEmits<{ (e: 'open', ref: string): void }>();

const store = useImprovementsStore();
const assistant = useAssistantStore();
const router = useRouter();

onMounted(() => {
  if (!store.items.length) void store.load();
});

const proposal = computed(() => store.items.find((p) => p.id === props.id) ?? null);

function ask(p: ImprovementProposal) {
  assistant.open(whyScope(p), WHY_QUESTIONS[0], { title: `la mejora «${p.title}»`, context: whyContext(p) });
}

async function dismiss(p: ImprovementProposal) {
  await store.dismiss(p);
  void router.push({ name: 'improvements' });
}
</script>

<template>
  <div class="id">
    <header class="id__crumbs">
      <RouterLink :to="{ name: 'improvements' }" class="id__back" data-test="improvement-back">
        <span aria-hidden="true">‹</span> Mejoras
      </RouterLink>
      <span class="id__sep" aria-hidden="true">/</span>
      <span class="id__here">{{ proposal?.title ?? 'Mejora' }}</span>
    </header>

    <ImprovementCard
      v-if="proposal"
      class="id__card"
      :proposal="proposal"
      :state="store.states[proposal.id]"
      @run="store.open(proposal, $event)"
      @dismiss="dismiss(proposal)"
      @ask="ask(proposal)"
      @open="emit('open', $event)"
    />
    <p v-else-if="store.loading" class="id__note">Leyendo la mejora…</p>
    <p v-else class="id__note" role="status">Esta mejora ya no está pendiente (se abrió o se descartó).</p>
  </div>
</template>

<style scoped>
.id { display: flex; flex-direction: column; gap: 0.75rem; min-width: 0; max-width: 48rem; }
.id__crumbs { display: flex; align-items: center; gap: 0.4rem; min-width: 0; min-height: var(--tap-h); }
.id__back { display: inline-flex; align-items: center; gap: 0.25rem; min-height: var(--tap-h); color: var(--info); font-weight: 500; }
.id__back:hover { text-decoration: none; color: var(--fg); }
.id__sep { color: var(--fg-dimmer); }
.id__here { min-width: 0; overflow: hidden; color: var(--fg-dim); text-overflow: ellipsis; white-space: nowrap; }
.id__note { margin: 0; color: var(--fg-dim); }
</style>
