<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { useCollapsed } from '@/composables/useCollapsed';
import ActionError from '@/features/inbox/decisions/ActionError.vue';
import ArrangeActions from '@/features/inbox/decisions/ArrangeActions.vue';
import AgeStamp from '@/features/inbox/decisions/AgeStamp.vue';
import DecisionDetail from '@/features/inbox/decisions/DecisionDetail.vue';
import InlineConfirm from '@/features/inbox/decisions/InlineConfirm.vue';
import ReasonChips from '@/features/inbox/decisions/ReasonChips.vue';
import RefLink from '@/features/inbox/decisions/RefLink.vue';
import type { QueueEntry } from '@/features/inbox/queue/entries';
import { useInboxStore } from '@/features/inbox/store';
import { useDecisionAction } from '@/features/inbox/useDecisionAction';

// «Lo primero» (v5, como el hero del menú de Mac): la decisión que más mueve el trabajo. Arriba el
// título de la sección (lo pliega) y cuánto espera; después qué es (el verbo, chico, en el tono del
// tipo), el título de la tarea como lo destacado, el link y las razones en una línea, y la fila de
// acciones: el ÚNICO primario de la pantalla, «Ver» (el detalle en grande, con todas las acciones) y
// «Por qué ▾», que despliega el porqué con Posponer y Fijar.

/** «Lo primero» plegado: se recuerda en este navegador. */
const folded = useCollapsed('first');
const props = defineProps<{ entry: QueueEntry; total: number }>();

const store = useInboxStore();
const act = useDecisionAction({ action: () => props.entry.action, targets: () => [props.entry.item] });
const detail = ref<InstanceType<typeof DecisionDetail> | null>(null);
const tone = computed(() => ({ '--tone': `var(--${props.entry.tone})` }));
/** El porqué (con Posponer y Fijar): plegado hasta que se pide, en cualquier ancho. */
const whyOpen = ref(false);

async function press() {
  if ((await act.ask()) === 'needs-comment') {
    whyOpen.value = true;
    await nextTick();
    detail.value?.focus();
  }
}
</script>

<template>
  <div class="fd-c" data-test="first">
    <article :id="`card-${entry.ref}`" class="fd" :class="{ 'fd--folded': folded }" :style="tone" aria-labelledby="first-title">
      <div class="fd__top">
        <h2 class="fd__kicker">
          <button
            type="button"
            class="fd__fold"
            :aria-expanded="!folded"
            aria-controls="first-body"
            data-test="first-fold"
            @click="folded = !folded"
          >
            <span class="fd__chev" aria-hidden="true">{{ folded ? '▸' : '▾' }}</span>
            Lo primero · 1 de {{ total }}
          </button>
        </h2>
        <AgeStamp :age="entry.age" prefix="esperando" />
        <p v-if="folded" class="fd__peek">{{ entry.title }}</p>
      </div>

      <div id="first-body" class="fd__body">
        <p class="fd__verb"><span class="fd__glyph" aria-hidden="true">{{ entry.glyph }}</span>{{ entry.verb }}</p>
        <h3 id="first-title" class="fd__title">{{ entry.title }}</h3>
        <div class="fd__why">
          <RefLink :short="entry.short" :url="entry.url" />
          <ReasonChips :reasons="entry.reasons" />
        </div>

        <InlineConfirm
          v-if="act.confirming.value && act.copy.value"
          primary
          :text="act.copy.value.text"
          :label="act.copy.value.label"
          :busy="act.busy.value"
          @cancel="act.cancel()"
          @confirm="act.confirm()"
        />
        <ActionError v-if="act.failure.value" :failure="act.failure.value" :busy="act.busy.value" @retry="act.retry()" />
        <p v-else-if="act.done.value" class="fd__ok" role="status">✓ {{ act.done.value.message }}</p>

        <div v-if="!act.confirming.value" class="fd__actions">
          <button
            v-if="entry.action"
            type="button"
            class="btn btn--primary fd__act"
            :data-action="entry.action.id"
            :disabled="act.busy.value"
            @click="press"
          >
            {{ act.busy.value ? '· ejecutando' : entry.action.label }}
          </button>
          <button type="button" class="btn fd__see" data-test="first-see" @click="store.expand(entry.ref)">Ver</button>
          <button
            type="button"
            class="btn btn--ghost fd__more"
            :aria-expanded="whyOpen"
            aria-controls="first-detail"
            data-test="first-why"
            @click="whyOpen = !whyOpen"
          >
            Por qué {{ whyOpen ? '▴' : '▾' }}
          </button>
        </div>

        <div id="first-detail" class="fd__detail" :class="{ 'fd__detail--open': whyOpen }">
          <DecisionDetail ref="detail" v-model:comment="act.comment.value" :entry="entry" />
          <ArrangeActions :item="entry.item" />
        </div>
      </div>
    </article>
  </div>
</template>

<style scoped>
.fd-c { min-width: 0; }
.fd {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  padding: 0.75rem 0.9rem 0.85rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--panel-alt);
  min-width: 0;
}
.fd__top { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0 0.75rem; }
.fd__kicker { margin: 0; color: var(--fg-dim); font-family: var(--font-body); font-size: var(--fs-chrome); font-weight: 600; letter-spacing: 0; }
/* El título de la sección pliega la card: plegada queda sólo el título de la tarea. */
.fd__fold { display: inline-flex; align-items: center; gap: 0.35rem; min-height: var(--tap-h-sm); padding: 0; border: 0; background: none; color: inherit; font: inherit; cursor: pointer; }
.fd__fold:focus:not(:focus-visible) { outline: none; }
.fd__chev { width: 0.8rem; }
.fd__top :deep(.age) { color: var(--fg-dim); font-size: var(--fs-chrome); }
.fd__peek { flex: 1 1 100%; margin: 0; color: var(--fg); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fd__body { display: flex; flex-direction: column; gap: 0.45rem; min-width: 0; }
/* Qué es: chico, en el tono del tipo. Lo que se lee primero es el título. */
.fd__verb { display: flex; align-items: baseline; gap: 0.35rem; margin: 0; color: var(--tone); font-size: var(--fs-body-sm); font-weight: 600; }
.fd__glyph { flex: none; }
.fd__title { margin: 0; color: var(--fg); font-family: var(--font-body); font-size: 1.05rem; font-weight: 600; line-height: 1.3; letter-spacing: -0.005em; overflow-wrap: anywhere; }
.fd__why { display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem 0.5rem; }
.fd__ok { margin: 0; color: var(--accent); font-size: var(--fs-body-sm); }
.fd__actions { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.2rem; }
/* El primario de la pantalla: más alto que un `.btn` y el que se estira. */
.fd__act { flex: 1; height: var(--tap-h-lg); padding: 0 1.25rem; }
.fd__see { flex: none; }
.fd__more { flex: none; padding: 0 0.6rem; color: var(--fg-mute); }
.fd__detail { display: flex; flex-direction: column; gap: 0.6rem; padding-top: 0.6rem; border-top: 1px solid var(--border-mute); }
.fd__detail:not(.fd__detail--open) { display: none; }
@container first (min-width: 36rem) {
  .fd { padding: 0.9rem 1.1rem 1rem; }
  .fd__act { flex: 0 1 auto; min-width: 12rem; }
}
.fd-c { container: first / inline-size; }
/* Plegada queda sólo el encabezado (con el título de la tarea). */
.fd.fd--folded .fd__body { display: none; }
</style>
