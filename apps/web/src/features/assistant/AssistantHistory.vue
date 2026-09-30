<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { formatRelative } from '@/composables/formatRelative';
import { useAssistantHistoryStore } from '@/features/assistant/historyStore';
import { useAssistantChatStore } from '@/features/assistant/store';
import { useGithubSessionStore } from '@/stores/githubSession';

// «Nueva» y «Anteriores» del contexto actual. Las conversaciones se guardan a
// nombre del login de GitHub: sin sesión, se avisa que ésta no queda. La lista va
// en el flujo del sheet (R6), y borrar pide confirmar en la misma fila.

const chat = useAssistantChatStore();
const history = useAssistantHistoryStore();
const session = useGithubSessionStore();

const open = ref(false);
const confirming = ref<string | null>(null);
const logged = computed(() => session.github !== null);

// La lista es del contexto: al cambiarlo (o al guardarse una nueva) se vuelve a pedir.
watch(
  [open, () => chat.scope, () => chat.conversationId, logged],
  () => {
    confirming.value = null;
    if (open.value && logged.value) void history.load();
  },
  { deep: true },
);

async function resume(id: string) {
  await history.open(id);
  open.value = false;
}
</script>

<template>
  <div class="ah">
    <div class="ah__bar">
      <button
        type="button"
        class="btn"
        data-test="new"
        :disabled="chat.streaming || !chat.turns.length"
        @click="chat.newConversation()"
      >
        + Nueva
      </button>
      <button
        v-if="logged"
        type="button"
        class="btn btn--ghost"
        data-test="toggle"
        :aria-expanded="open"
        @click="open = !open"
      >
        Anteriores {{ open ? '▴' : '▾' }}
      </button>
      <p v-else class="ah__hint">
        Sin sesión de GitHub esta conversación no se guarda.
        <button type="button" class="ah__link" @click="session.requestLogin()">Entrar</button>
      </p>
    </div>

    <div v-if="open && logged" class="ah__list">
      <p v-if="history.error" class="ah__err" role="alert">✕ {{ history.error }}</p>
      <p v-else-if="history.loading && !history.items.length" class="ah__dim">· cargando…</p>
      <p v-else-if="!history.items.length" class="ah__dim">Todavía no hay conversaciones guardadas en este contexto.</p>
      <ul v-else>
        <li v-for="item in history.items" :key="item.id" class="ah__item" :data-current="item.id === chat.conversationId">
          <template v-if="confirming === item.id">
            <span class="ah__ask">¿Borrar «{{ item.title }}»?</span>
            <span class="ah__actions">
              <button type="button" class="btn" @click="confirming = null">Cancelar</button>
              <button type="button" class="btn btn--destructive" data-test="confirm-delete" @click="history.remove(item.id)">
                Borrar
              </button>
            </span>
          </template>
          <template v-else>
            <button type="button" class="ah__open" :data-test="`open-${item.id}`" @click="resume(item.id)">
              <span class="ah__title">{{ item.title }}</span>
              <span class="ah__meta mono">{{ formatRelative(item.updated_at) }} · {{ item.messages / 2 }} {{ item.messages === 2 ? 'pregunta' : 'preguntas' }}</span>
            </button>
            <button
              type="button"
              class="btn btn--ghost"
              :data-test="`delete-${item.id}`"
              :aria-label="`Borrar ${item.title}`"
              @click="confirming = item.id"
            >
              Borrar
            </button>
          </template>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.ah { display: flex; flex-direction: column; gap: 0.35rem; padding: 0 1rem 0.5rem; }
.ah__bar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
.ah__hint { flex: 1 1 12rem; margin: 0; color: var(--fg-dim); font-size: var(--fs-body-sm); }
/* Un link de texto dentro de la línea: el blanco táctil lo da la fila (R11). */
.ah__link { min-height: var(--tap-h); padding: 0 0.25rem; border: 0; background: none; color: var(--info); font: inherit; text-decoration: underline; cursor: pointer; }
.ah__list { border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel); }
.ah__list ul { margin: 0; padding: 0; list-style: none; }
.ah__item { display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem 0.5rem; padding: 0 0.5rem 0 0; border-bottom: 1px solid var(--border-mute); border-left: 3px solid transparent; }
.ah__item:last-child { border-bottom: 0; }
.ah__item[data-current='true'] { border-left-color: var(--accent); }
.ah__open { display: flex; flex: 1 1 12rem; flex-direction: column; gap: 0.1rem; min-width: 0; min-height: var(--tap-h); padding: 0.4rem 0.75rem; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.ah__open:hover { background: var(--panel-alt); }
.ah__open:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
.ah__title { color: var(--fg); font-size: var(--fs-body-sm); overflow-wrap: anywhere; }
.ah__meta { color: var(--fg-dim); font-size: var(--fs-micro); }
.ah__ask { flex: 1 1 12rem; padding: 0.4rem 0.75rem; color: var(--fg); font-size: var(--fs-body-sm); overflow-wrap: anywhere; }
.ah__actions { display: flex; gap: 0.5rem; padding: 0.25rem 0; }
.ah__dim { margin: 0; padding: 0.6rem 0.75rem; color: var(--fg-dim); font-size: var(--fs-body-sm); }
.ah__err { margin: 0; padding: 0.6rem 0.75rem; color: var(--danger); font-size: var(--fs-body-sm); }
</style>
