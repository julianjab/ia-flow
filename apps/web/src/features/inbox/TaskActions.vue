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
// detalle tapa la bandeja, así que no compite con «Lo primero».

const props = defineProps<{ item: InboxItem; bar?: boolean }>();
const primaryId = computed(() => primaryOf(props.item));

const comment = ref('');

const actions = computed<QueueAction[]>(() => {
  const primary = primaryOf(props.item);
  const rank = (id: string) => (id === primary ? 0 : id === 'stop' ? 2 : 1);
  return [...props.item.actions]
    .sort((a, b) => rank(a) - rank(b))
    .map((id) => actionOf(id, props.item.action_defs ?? []));
});
const takesText = computed(() => actions.value.some((a) => a.comment !== undefined));
const replyId = computed(() => `reply-${props.item.ref}`);
const blocked = (action: QueueAction) => action.comment === 'required' && !comment.value.trim();

function sent(action: QueueAction) {
  if (action.comment) comment.value = '';
}
</script>

<template>
  <div v-if="actions.length" class="ta" :data-bar="bar">
    <div v-if="takesText" class="ta__reply">
      <label class="uc-label" :for="replyId">Tu respuesta</label>
      <textarea :id="replyId" v-model="comment" class="ff-field ff-textarea" rows="3" />
      <p class="ff-hint">Se publica como comentario en el issue, con tu usuario de GitHub.</p>
    </div>

    <div class="ta__row">
      <ActionButton
        v-for="action in actions"
        :key="action.id"
        :action="action"
        :item="item"
        :comment="comment"
        :blocked="blocked(action)"
        :danger="action.id === 'stop'"
        :primary="bar && action.id === primaryId"
        @done="sent(action)"
      />
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
</style>
