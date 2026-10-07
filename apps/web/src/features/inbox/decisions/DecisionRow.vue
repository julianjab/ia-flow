<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import ActionError from '@/features/inbox/decisions/ActionError.vue';
import AgeStamp from '@/features/inbox/decisions/AgeStamp.vue';
import DecisionChild from '@/features/inbox/decisions/DecisionChild.vue';
import DecisionDetail from '@/features/inbox/decisions/DecisionDetail.vue';
import InlineConfirm from '@/features/inbox/decisions/InlineConfirm.vue';
import ReasonChips from '@/features/inbox/decisions/ReasonChips.vue';
import RefLink from '@/features/inbox/decisions/RefLink.vue';
import type { QueueRow } from '@/features/inbox/queue/entries';
import { useInboxStore } from '@/features/inbox/store';
import { useDecisionAction } from '@/features/inbox/useDecisionAction';

// Una fila de «Después»: número, glifo y verbo en el tono del TIPO, título, link corto, hasta 2
// razones, antigüedad, el toggle del detalle y el botón de su acción — siempre en la fila
// cerrada; abrir sólo agrega el porqué debajo. Un grupo («Mergear 2 PRs») abre sus hijas, cada
// una con su botón, y su propio botón corre la acción sobre todas, en serie.

const props = defineProps<{ row: QueueRow }>();

const store = useInboxStore();
const single = computed(() => (props.row.kind === 'single' ? props.row : null));
const targets = computed(() => (props.row.kind === 'group' ? props.row.children.map((c) => c.item) : [props.row.item]));
const act = useDecisionAction({ action: () => props.row.action, targets: () => targets.value });

const groupOpen = ref(false);
const open = computed(() => (single.value ? store.openRef === single.value.ref : groupOpen.value));
const domId = computed(() => (props.row.kind === 'group' ? props.row.key : `card-${props.row.ref}`));
const detailId = computed(() => `${domId.value}-detail`);
const tone = computed(() => ({ '--tone': `var(--${props.row.tone})` }));
const detail = ref<InstanceType<typeof DecisionDetail> | null>(null);

function toggle() {
  if (single.value) store.toggle(single.value.ref);
  else groupOpen.value = !groupOpen.value;
}

async function press() {
  if ((await act.ask()) !== 'needs-comment' || !single.value) return;
  if (!open.value) store.toggle(single.value.ref);
  await nextTick();
  detail.value?.focus();
}

/** El grupo corta en la primera hija que falla: se abre para que su error se vea, junto a ella. */
async function confirm() {
  const ok = await act.confirm();
  if (!ok && props.row.kind === 'group') groupOpen.value = true;
}
</script>

<template>
  <article :id="domId" class="dr" :style="tone" :data-kind="row.kind" :data-type="row.type">
    <div class="dr__head">
      <span class="dr__rank mono">{{ row.rank }}</span>
      <div class="dr__what">
        <h3 class="dr__verb"><span class="dr__glyph" aria-hidden="true">{{ row.glyph }}</span>{{ row.verb }}</h3>
        <p class="dr__title">{{ row.title }}</p>
        <div class="dr__why">
          <RefLink v-if="single" :short="single.short" :url="single.url" />
          <ReasonChips :reasons="row.reasons" />
        </div>
      </div>
      <!-- Mientras se confirma, la confirmación es lo único: sin antigüedad, toggle ni botón. -->
      <div v-if="!act.confirming.value" class="dr__side">
        <AgeStamp :age="row.age" />
        <button
          type="button"
          class="btn btn--ghost dr__toggle"
          :aria-expanded="open"
          :aria-controls="detailId"
          :aria-label="open ? `Ocultar el detalle de ${row.verb}` : `Ver el detalle de ${row.verb}`"
          data-test="toggle"
          @click="toggle"
        >
          {{ open ? '▴' : '▾' }}
        </button>
        <button
          v-if="row.action"
          type="button"
          class="btn dr__act"
          :data-action="row.action.id"
          :disabled="act.busy.value"
          @click="press"
        >
          {{ act.busy.value ? '· ejecutando' : row.action.label }}
        </button>
      </div>
    </div>

    <InlineConfirm
      v-if="act.confirming.value && act.copy.value"
      class="dr__in"
      :text="act.copy.value.text"
      :label="act.copy.value.label"
      :busy="act.busy.value"
      @cancel="act.cancel()"
      @confirm="confirm"
    />
    <ActionError v-if="act.failure.value" class="dr__in" :failure="act.failure.value" :busy="act.busy.value" @retry="act.retry()" />
    <p v-else-if="act.done.value" class="dr__in dr__ok" role="status">✓ {{ act.done.value.message }}</p>

    <!-- Siempre en el DOM (el `aria-controls` del toggle apunta acá); el contenido, sólo abierto. -->
    <div v-show="open" :id="detailId" class="dr__in">
      <template v-if="open">
        <ul v-if="row.kind === 'group'" class="dr__kids">
          <DecisionChild v-for="child in row.children" :key="child.ref" :entry="child" />
        </ul>
        <DecisionDetail v-else-if="single" ref="detail" v-model:comment="act.comment.value" :entry="single" />
      </template>
    </div>
  </article>
</template>

<style scoped>
.dr { display: flex; flex-direction: column; gap: 0.5rem; padding: 0.7rem 0.75rem; border-top: 1px solid var(--border-mute); min-width: 0; }
.dr__head { display: grid; gap: 0.5rem 0.5rem; align-items: start; }
.dr__rank { color: var(--fg-dim); font-variant-numeric: tabular-nums; line-height: var(--row-h); }
.dr__what { display: flex; flex-direction: column; gap: 0.15rem; min-width: 0; }
.dr__verb { display: flex; align-items: baseline; gap: 0.5rem; margin: 0; color: var(--tone); font-family: var(--font-body); font-size: var(--fs-body); font-weight: 600; letter-spacing: 0; overflow-wrap: anywhere; }
.dr__glyph { flex: none; width: 1rem; }
.dr__title { margin: 0; color: var(--fg-mute); line-height: 1.4; overflow-wrap: anywhere; }
.dr__why { display: flex; flex-wrap: wrap; align-items: center; gap: 0 0.5rem; }
/* Teléfono: la antigüedad arriba a la derecha, en la línea del verbo; abajo, la acción a lo
   ancho y el toggle a su derecha. `.dr__side` se disuelve en la grilla para ubicar cada pieza. */
.dr__head { grid-template-columns: 1.4rem minmax(0, 1fr) auto; }
.dr__rank { grid-column: 1; grid-row: 1; }
.dr__side { display: contents; }
.dr__what { grid-column: 2; grid-row: 1; }
.dr__side .age { grid-column: 3; grid-row: 1; line-height: var(--row-h); }
.dr__act { grid-column: 2; grid-row: 2; }
.dr__toggle { grid-column: 3; grid-row: 2; width: var(--tap-h); padding: 0; }
.dr__in { margin-left: 1.9rem; }
.dr__ok { margin: 0 0 0 1.9rem; color: var(--accent); font-size: var(--fs-body-sm); }
.dr__kids { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border-mute); border-radius: var(--radius); }
@media (min-width: 640px) {
  .dr { padding: 0.75rem 1rem; }
  .dr__head { gap: 0.5rem 1rem; }
  .dr__side { display: flex; grid-column: 3; grid-row: 1; align-items: center; gap: 0.4rem; }
  .dr__side .age { margin-right: 0.25rem; }
  .dr__toggle { order: 1; }
  .dr__act { order: 2; flex: none; }
}
</style>
