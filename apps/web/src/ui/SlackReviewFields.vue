<script setup lang="ts">
import { useIntegrations } from '@/composables/useIntegrations';
import { lookupChannel } from '@/composables/useSlackDirectory';
import type { SlackMemberRef, SlackReviewMessage } from '@ia-flow/shared';
import { DEFAULT_SLACK_REVIEW_MESSAGES, SLACK_REVIEW_TEMPLATE_VARS } from '@ia-flow/shared';
import { computed, ref, watch } from 'vue';
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
//
// **Sin Slack no se dibuja.** El guard está acá y no en cada uno de los tres
// llamadores porque es la misma pregunta las tres veces, y una copia olvidada
// dejaría un formulario que no puede funcionar. Lo consumen también los slots:
// `SlackReviewSettings` monta esto como raíz, así que su botón de guardar se va
// con la caja.

const props = defineProps<{
  channel: string;
  reviewers: SlackMemberRef[];
  /** Los dos textos del pedido. Vacío ⇒ hereda (proyecto → default). */
  message: SlackReviewMessage;
  /** Qué se hereda cuando estos campos quedan vacíos. */
  inheritLabel?: string;
  /** Contexto que sólo tiene sentido desplegado (de dónde salen estos valores,
   *  quién los sobreescribe). Colapsado no se muestra. */
  description?: string;
}>();

const { integrations } = useIntegrations();

const emit = defineEmits<{
  (e: 'update:channel', value: string): void;
  (e: 'update:reviewers', value: SlackMemberRef[]): void;
  (e: 'update:message', value: SlackReviewMessage): void;
}>();

// El default vigente va de placeholder y no de valor inicial: precargarlo
// convertiría a todo repo que abra el desplegable en un repo con override, y
// el texto dejaría de seguir al default cuando éste cambie.
const DEFAULTS = DEFAULT_SLACK_REVIEW_MESSAGES;

function setMessage(key: 'first' | 'reReview', value: string) {
  emit('update:message', { ...props.message, [key]: value });
}

const open = ref(false);

// El resumen de la fila cerrada mostraba el id crudo del canal (`C0AG…`), que
// no le dice nada a nadie. `lookupChannel` cachea por id a nivel módulo, así
// que resolverlo en cada fila del listado cuesta un request, no uno por fila.
// Sólo mientras está CERRADO, que es cuando el resumen se ve. Abierto, el
// canal lo edita el SlackChannelField de adentro y cada tecla emite un cambio
// de prop: resolver ahí sería un request por pulsación (ver el mismo guard en
// SlackChannelField). Al cerrar, el watcher corre una vez con el valor final.
const channelName = ref<string | null>(null);
watch(
  [() => props.channel, open],
  async ([v, isOpen]) => {
    if (isOpen) return;
    const hit = await lookupChannel(v);
    if (props.channel === v) channelName.value = hit?.name ?? null;
  },
  { immediate: true },
);

const summary = computed(() => {
  const parts: string[] = [];
  const channel = props.channel.trim();
  // Con nombre resuelto se muestra `#nombre`; sin él queda el id, que es lo
  // único cierto (el bot puede no ver ese canal, o faltar el token).
  if (channel) parts.push(channelName.value ? `#${channelName.value}` : channel);
  if (props.reviewers.length) parts.push(`${props.reviewers.length} reviewer(s)`);
  const custom = [props.message.first, props.message.reReview].filter((t) => t?.trim()).length;
  if (custom) parts.push(`${custom} texto(s) propio(s)`);
  return parts.length ? parts.join(' · ') : (props.inheritLabel ?? 'hereda del proyecto');
});

const inherits = computed(() => !props.channel.trim() || !props.reviewers.length);

const VARS = SLACK_REVIEW_TEMPLATE_VARS.map((v) => `{{${v}}}`).join(', ');
</script>

<template>
  <div v-if="integrations.slack.enabled" class="srf">
    <button type="button" class="srf-head" :aria-expanded="open" @click="open = !open">
      <span class="srf-glyph">{{ open ? '▾' : '▸' }}</span>
      <span class="uc-label">Review en Slack</span>
      <span class="srf-summary" :class="{ 'is-inherited': inherits }">{{ summary }}</span>
    </button>

    <div v-if="open" class="srf-body">
      <p v-if="description" class="srf-desc">{{ description }}</p>

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

      <div class="srf-field">
        <label class="uc-label">Texto del primer pedido</label>
        <textarea
          class="srf-textarea mono"
          rows="4"
          :value="message.first ?? ''"
          :placeholder="DEFAULTS.first"
          @input="setMessage('first', ($event.target as HTMLTextAreaElement).value)"
        ></textarea>
      </div>

      <div class="srf-field">
        <label class="uc-label">Texto del re-review</label>
        <textarea
          class="srf-textarea mono"
          rows="2"
          :value="message.reReview ?? ''"
          :placeholder="DEFAULTS.reReview"
          @input="setMessage('reReview', ($event.target as HTMLTextAreaElement).value)"
        ></textarea>
      </div>

      <p class="srf-hint">
        Variables disponibles en los textos: <code>{{ VARS }}</code>. Una línea que sólo
        tenga una variable vacía se omite.
      </p>

      <p class="srf-hint">
        Vacío hereda {{ inheritLabel ?? 'del proyecto' }}. Cada campo cae por separado.
      </p>

      <!-- Las acciones van DENTRO del desplegable: un botón de guardar visible
           con el bloque cerrado no dice qué guarda. -->
      <div v-if="$slots.actions" class="srf-actions"><slot name="actions" /></div>
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
.srf-desc { margin: 0; color: var(--fg-dim); font-size: var(--fs-body-sm); }
.srf-hint { margin: 0; color: var(--fg-dimmer); font-size: var(--fs-micro); }
.srf-hint code { font-family: var(--font-mono); }
/* El theme ya estila `textarea` (fondo, borde, radio, foco): acá sólo el ancho
   y el resize, que son de este layout. La voz mono la pide `.mono`. */
.srf-textarea { width: 100%; resize: vertical; }
.srf-actions { display: flex; justify-content: flex-end; }
</style>
