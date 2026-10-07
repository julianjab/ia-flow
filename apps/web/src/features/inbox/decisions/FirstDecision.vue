<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import ActionError from '@/features/inbox/decisions/ActionError.vue';
import AgeStamp from '@/features/inbox/decisions/AgeStamp.vue';
import DecisionDetail from '@/features/inbox/decisions/DecisionDetail.vue';
import InlineConfirm from '@/features/inbox/decisions/InlineConfirm.vue';
import ReasonChips from '@/features/inbox/decisions/ReasonChips.vue';
import RefLink from '@/features/inbox/decisions/RefLink.vue';
import type { QueueEntry } from '@/features/inbox/queue/entries';
import { useDecisionAction } from '@/features/inbox/useDecisionAction';

// «Lo primero»: la decisión que más mueve el trabajo, en grande. El verbo en Condensed, el título
// debajo, el ÚNICO botón primario de la pantalla a la vista, el link corto, hasta 3 razones y,
// bajo un separador, el porqué y las acciones terciarias. En el teléfono la card es corta —verbo,
// título, link y razones, y el botón a lo ancho al final— y el porqué se pliega tras «Por qué ▾».

const props = defineProps<{ entry: QueueEntry; total: number }>();

const act = useDecisionAction({ action: () => props.entry.action, targets: () => [props.entry.item] });
const detail = ref<InstanceType<typeof DecisionDetail> | null>(null);
const tone = computed(() => ({ '--tone': `var(--${props.entry.tone})` }));
/** El porqué abierto en el teléfono; desde 640 px se ve siempre. */
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
  <article :id="`card-${entry.ref}`" class="fd" :style="tone" aria-labelledby="first-verb" data-test="first">
    <div class="fd__top">
      <h2 class="uc-label fd__kicker">Lo primero · 1 de {{ total }}</h2>
      <AgeStamp :age="entry.age" prefix="esperando" />
    </div>

    <div class="fd__main">
      <div class="fd__what">
        <h3 id="first-verb" class="fd__verb">
          <span class="fd__glyph" aria-hidden="true">{{ entry.glyph }}</span>{{ entry.verb }}
        </h3>
        <p class="fd__title">{{ entry.title }}</p>
      </div>
      <button
        v-if="entry.action && !act.confirming.value"
        type="button"
        class="btn btn--primary fd__act"
        :data-action="entry.action.id"
        :disabled="act.busy.value"
        @click="press"
      >
        {{ act.busy.value ? '· ejecutando' : entry.action.label }}
      </button>
    </div>

    <InlineConfirm
      v-if="act.confirming.value && act.copy.value"
      class="fd__in"
      primary
      :text="act.copy.value.text"
      :label="act.copy.value.label"
      :busy="act.busy.value"
      @cancel="act.cancel()"
      @confirm="act.confirm()"
    />
    <ActionError v-if="act.failure.value" class="fd__in" :failure="act.failure.value" :busy="act.busy.value" @retry="act.retry()" />
    <p v-else-if="act.done.value" class="fd__in fd__ok" role="status">✓ {{ act.done.value.message }}</p>

    <div class="fd__why">
      <RefLink :short="entry.short" :url="entry.url" />
      <ReasonChips :reasons="entry.reasons" />
    </div>

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
    <div id="first-detail" class="fd__detail" :class="{ 'fd__detail--open': whyOpen }">
      <DecisionDetail ref="detail" v-model:comment="act.comment.value" :entry="entry" />
    </div>
  </article>
</template>

<style scoped>
.fd {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  padding: 0.9rem;
  border: 1px solid var(--border-hi);
  border-radius: var(--radius);
  background: var(--panel);
  min-width: 0;
}
.fd__top { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 0.25rem 0.75rem; }
/* El h2 de la sección (como «Después»), con la voz de la etiqueta: el verbo de abajo es el h3. */
.fd__kicker { margin: 0; color: var(--accent); font-weight: 400; }
/* Teléfono: los hijos de .fd__main se ordenan con los de la card —el botón va después del link y
   las razones— y el porqué queda plegado. */
.fd__main { display: contents; }
.fd__top { order: 0; }
.fd__what { order: 1; }
.fd__why { order: 2; }
.fd__act { order: 3; }
.fd__in { order: 4; }
.fd__more { order: 5; align-self: flex-start; padding: 0 0.6rem; margin-left: -0.6rem; color: var(--fg-mute); }
.fd__detail { order: 6; }
.fd__detail:not(.fd__detail--open) { display: none; }
.fd__what { display: flex; flex-direction: column; gap: 0.3rem; min-width: 0; }
.fd__verb {
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
  margin: 0;
  color: var(--tone);
  font-size: var(--fs-num);
  line-height: 1.2;
  overflow-wrap: anywhere;
}
.fd__glyph { flex: none; width: 1.1rem; }
.fd__title { margin: 0; padding-left: 1.7rem; color: var(--fg); font-size: var(--fs-body); font-weight: 500; line-height: 1.4; overflow-wrap: anywhere; }
/* El primario de la pantalla: más alto que un `.btn` y, en el teléfono, a todo el ancho. */
.fd__act { height: var(--tap-h-lg); width: 100%; padding: 0 1.25rem; }
.fd__in { margin-left: 0; }
.fd__why { display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem 0.5rem; }
.fd__ok { margin: 0; color: var(--accent); font-size: var(--fs-body-sm); }
@media (min-width: 640px) {
  .fd { padding: 1rem 1.1rem; }
  .fd__main { order: 1; display: flex; flex-direction: row; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 0.75rem; }
  .fd__in { order: 2; }
  .fd__why { order: 3; }
  .fd__more { display: none; }
  .fd__detail, .fd__detail:not(.fd__detail--open) { display: block; order: 4; }
  .fd__what { flex: 1 1 20rem; }
  .fd__act { width: auto; margin-left: auto; }
  .fd__verb { font-size: var(--fs-display); }
  .fd__in, .fd__why, .fd__detail { margin-left: 1.7rem; }
}
</style>
