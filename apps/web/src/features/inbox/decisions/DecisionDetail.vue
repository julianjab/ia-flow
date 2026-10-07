<script setup lang="ts">
import { computed, ref } from 'vue';
import { formatRelative } from '@/composables/formatRelative';
import ActionButton from '@/features/inbox/decisions/ActionButton.vue';
import Disclosure from '@/features/inbox/Disclosure.vue';
import { nextOf } from '@/features/inbox/queue/advice';
import type { QueueEntry } from '@/features/inbox/queue/entries';
import type { QueueAction } from '@/features/inbox/queue/kinds';
import { prShortOf } from '@/features/inbox/queue/shortRef';
import { useInboxStore } from '@/features/inbox/store';
import { useAssistantStore } from '@/stores/assistant';

// El porqué de una decisión, una sola vez cada cosa: «Qué pasó» en texto humano, lo que dijo el
// agente (✦, sólo texto de modelo), «→ qué hacer», el texto para responder si la acción lo pide,
// el error crudo plegado en «Detalle técnico» y, al final, las acciones terciarias.

const props = defineProps<{ entry: QueueEntry }>();
const comment = defineModel<string>('comment', { default: '' });

const store = useInboxStore();
const assistant = useAssistantStore();

const detail = computed(() => props.entry.detail);
const next = computed(() => nextOf(props.entry));
/** El textarea sale si la acción principal o alguna secundaria lleva texto. */
const takesText = computed(() =>
  [props.entry.action, ...props.entry.secondary].some((a) => a?.comment !== undefined),
);
/** Una acción que exige texto no se puede tocar con el textarea vacío (como en TaskActions). */
const blocked = (action: QueueAction) => action.comment === 'required' && !comment.value.trim();
const replyId = computed(() => `reply-${props.entry.ref}`);
const runId = computed(() => props.entry.item.execution?.id);

const reply = ref<HTMLTextAreaElement | null>(null);
defineExpose({ focus: () => reply.value?.focus() });
</script>

<template>
  <div class="dd">
    <div v-if="detail.happened" class="dd__block">
      <span class="uc-label">Qué pasó</span>
      <p class="dd__text">{{ detail.happened }}</p>
    </div>
    <div v-if="detail.said" class="dd__block">
      <span class="uc-label">
        <span class="dd__ai"><span aria-hidden="true">✦</span> {{ detail.saidBy }}</span>
        <time v-if="detail.saidAt" :datetime="detail.saidAt" :title="detail.saidAt"> · {{ formatRelative(detail.saidAt) }}</time>
      </span>
      <p class="dd__said">{{ detail.said }}</p>
    </div>
    <p v-if="next" class="dd__next">→ {{ next }}</p>

    <div v-if="takesText" class="dd__block">
      <label class="uc-label" :for="replyId">Tu respuesta · se publica como comentario</label>
      <textarea
        :id="replyId"
        ref="reply"
        v-model="comment"
        class="ff-field ff-textarea dd__reply"
        rows="3"
        :aria-describedby="`${replyId}-hint`"
      />
      <p :id="`${replyId}-hint`" class="ff-hint">Se publica en el issue con tu usuario de GitHub.</p>
    </div>

    <Disclosure v-if="detail.tech" title="Detalle técnico" tag="span" class="dd__tech">
      <template #meta><span v-if="runId" class="dd__run mono">{{ runId }}</span></template>
      <pre class="dd__pre mono">{{ detail.tech }}</pre>
    </Disclosure>

    <div class="dd__more">
      <a class="btn btn--ghost" :href="entry.url" target="_blank" rel="noopener noreferrer">Issue ↗</a>
      <a v-if="entry.item.pr" class="btn btn--ghost" :href="entry.item.pr.url" target="_blank" rel="noopener noreferrer"
        >{{ prShortOf(entry.item) }} ↗</a
      >
      <ActionButton
        v-for="action in entry.secondary"
        :key="action.id"
        ghost
        :action="action"
        :item="entry.item"
        :comment="comment"
        :blocked="blocked(action)"
      />
      <button type="button" class="btn btn--ghost" data-test="runs" @click="store.expand(entry.ref)">Corridas</button>
      <button type="button" class="btn btn--ghost" data-test="ask" @click="assistant.open({ kind: 'task', ref: entry.ref })">
        ◆ Abrir en el asistente
      </button>
    </div>
  </div>
</template>

<style scoped src="@/ui/form-fields.css" />
<style scoped>
.dd { display: flex; flex-direction: column; gap: 0.75rem; padding-top: 0.65rem; border-top: 1px solid var(--border-mute); }
.dd__block { display: flex; flex-direction: column; gap: 0.25rem; }
.dd__text { margin: 0; color: var(--fg-mute); line-height: 1.5; overflow-wrap: anywhere; }
/* R16: `--ai` sólo marca (✦ y quién); el texto inferido va en --fg-mute, con su hora. */
.dd__ai { color: var(--ai); }
.dd__said { margin: 0; color: var(--fg-mute); line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.dd__next { margin: 0; color: var(--info); font-size: var(--fs-body-sm); line-height: 1.45; }
.dd__reply { min-height: 4.5rem; }
.dd__tech { background: var(--panel-alt); }
.dd__run { color: var(--fg-dimmer); font-size: var(--fs-micro); }
.dd__pre { margin: 0; padding: 0 0.75rem 0.75rem; color: var(--fg-mute); font-size: var(--fs-micro); line-height: 1.55; white-space: pre-wrap; word-break: break-all; max-height: 20rem; overflow-y: auto; }
.dd__more { display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem; margin-left: -0.6rem; }
.dd__more .btn--ghost { padding: 0 0.6rem; color: var(--fg-mute); }
.dd__more a.btn--ghost:hover { background: none; color: var(--fg); }
</style>
