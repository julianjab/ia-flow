<script setup lang="ts">
import type { InboxItem } from '@ia-flow/shared';
import { computed, ref } from 'vue';
import ActionButton from '@/features/inbox/decisions/ActionButton.vue';
import { actionOf, primaryOf, type QueueAction } from '@/features/inbox/queue/kinds';

// Las acciones que el runner ofrece sobre UNA tarea (`item.actions`) en el panel de detalle, con
// las mismas reglas que la cola: sólo confirman (en línea, en el lugar del botón) las que firman
// con GitHub o no se deshacen —merge, approve_prd, stop y las que el proyecto declara con
// `confirm`—, con «…» en su etiqueta y «<Verbo> ahora» en la confirmación; el error queda pegado
// al botón que falló, con «→ qué hacer» y «Reintentar». Sin login de GitHub no sale ninguna
// request: se pide el login.
//
// Neutras salvo «Detener…», riesgosa, en contorno `--danger` (DESIGN_SYSTEM «Botones»). La
// principal del caso va primero y «Detener…» al final. En el detalle (`bar`) los botones son la
// barra fija al pie (R3: la acción principal no scrollea), y ahí la principal sí es primaria: el
// detalle tapa la bandeja, así que no compite con «Lo primero». La barra ocupa una sola fila: la
// principal y «Más», que despliega el resto encima (en un teléfono, tres filas de botones le
// comían un tercio de la pantalla al detalle). Arriba de los botones, en la misma barra, va lo que
// el detalle ponga en el slot `bar` (la caja del asistente): sin acciones, la barra queda igual.

const props = defineProps<{ item: InboxItem; bar?: boolean }>();
const primaryId = computed(() => primaryOf(props.item));

const comment = ref('');
const more = ref(false);

const actions = computed<QueueAction[]>(() => {
  const primary = primaryOf(props.item);
  const rank = (id: string) => (id === primary ? 0 : id === 'stop' ? 2 : 1);
  return [...props.item.actions]
    .sort((a, b) => rank(a) - rank(b))
    .map((id) => actionOf(id, props.item.action_defs ?? []));
});
const takesText = computed(() => actions.value.some((a) => a.comment !== undefined));
const replyId = computed(() => `reply-${props.item.ref}`);
const moreId = computed(() => `more-${props.item.ref}`);
/** En la barra: la primera (la principal, si hay) va a la vista; el resto, tras «Más». */
const main = computed(() => (props.bar ? actions.value.slice(0, 1) : actions.value));
const rest = computed(() => (props.bar ? actions.value.slice(1) : []));
const blocked = (action: QueueAction) => action.comment === 'required' && !comment.value.trim();

function sent(action: QueueAction) {
  if (action.comment) comment.value = '';
}

const bind = (action: QueueAction) => ({
  action,
  item: props.item,
  comment: comment.value,
  blocked: blocked(action),
  danger: action.id === 'stop',
  primary: props.bar && action.id === primaryId.value,
});
</script>

<template>
  <div v-if="actions.length || $slots.bar" class="ta" :data-bar="bar">
    <div v-if="takesText" class="ta__reply">
      <label class="uc-label" :for="replyId">Tu respuesta</label>
      <textarea :id="replyId" v-model="comment" class="ff-field ff-textarea" rows="3" />
      <p class="ff-hint">Se publica como comentario en el issue, con tu usuario de GitHub.</p>
    </div>

    <div class="ta__row">
      <div v-if="$slots.bar" class="ta__lead"><slot name="bar" /></div>
      <div v-if="rest.length" v-show="more" :id="moreId" class="ta__more" data-test="more">
        <ActionButton v-for="action in rest" :key="action.id" v-bind="bind(action)" @done="sent(action)" />
      </div>
      <ActionButton v-for="action in main" :key="action.id" v-bind="bind(action)" @done="sent(action)" />
      <button
        v-if="rest.length"
        type="button"
        class="btn ta__toggle"
        :aria-expanded="more"
        :aria-controls="moreId"
        data-test="more-toggle"
        @click="more = !more"
      >
        {{ more ? 'Menos' : `Más · ${rest.length}` }}
      </button>
    </div>
  </div>
</template>

<style scoped src="@/ui/form-fields.css" />
<style scoped>
.ta { display: flex; flex-direction: column; gap: 0.6rem; }
.ta__reply { display: flex; flex-direction: column; gap: 0.25rem; }
.ta__reply .ff-textarea { min-height: 4.5rem; }
.ta__row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
/* La barra: pegada al pie del cuerpo que scrollea, con el fondo del panel para tapar lo de atrás.
   `.ta` se disuelve para que el sticky se mida contra el detalle entero y no contra esta caja. */
.ta[data-bar='true'] { display: contents; }
.ta[data-bar='true'] .ta__row {
  position: sticky;
  bottom: 0;
  z-index: 1;
  margin: 0 -1rem;
  padding: 0.6rem 1rem calc(0.6rem + env(safe-area-inset-bottom, 0px));
  border-top: 1px solid var(--border-mute);
  background: var(--panel);
}
.ta[data-bar='true'] .ta__row :deep(.btn) { flex: 1 1 auto; min-height: var(--tap-h-lg); }
.ta__lead { flex: 1 1 100%; min-width: 0; }
.ta__more { flex: 1 1 100%; display: flex; flex-wrap: wrap; gap: 0.5rem; }
.ta[data-bar='true'] .ta__row > .ta__toggle { flex: none; color: var(--fg-mute); }
</style>
