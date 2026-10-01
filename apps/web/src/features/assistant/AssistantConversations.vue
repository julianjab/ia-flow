<script setup lang="ts">
import { type AssistantConversationSummary, DEFAULT_ASSISTANT_AGENT } from '@ia-flow/shared';
import { computed, onMounted, ref, watch } from 'vue';
import { useAssistantHistoryStore } from '@/features/assistant/historyStore';
import { scopeLabel } from '@/features/assistant/scope';
import ScopeTag from '@/features/assistant/ScopeTag.vue';
import { useAssistantChatStore } from '@/features/assistant/store';
import { useGithubSessionStore } from '@/stores/githubSession';

// El menú lateral del asistente: todas tus conversaciones guardadas, de todos los
// contextos, agrupadas por fecha y con su contexto como etiqueta. «+ Nueva» arriba,
// siempre a mano. Se guardan por login de GitHub: sin sesión, lo dice.

const emit = defineEmits<{ (e: 'picked'): void }>();

const chat = useAssistantChatStore();
const history = useAssistantHistoryStore();
const session = useGithubSessionStore();

const query = ref('');
const confirming = ref<string | null>(null);

onMounted(() => void history.load());
// Una conversación nueva que se guardó, o cambió la sesión: la lista se relee.
watch([() => chat.conversationId, () => session.github], () => void history.load());

const DAY = 86_400_000;
function groupOf(iso: string, now = Date.now()): string {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const t = Date.parse(iso);
  if (t >= start.getTime()) return 'Hoy';
  if (t >= start.getTime() - DAY) return 'Ayer';
  if (t >= start.getTime() - 6 * DAY) return 'Esta semana';
  return 'Antes';
}

function time(iso: string): string {
  const d = new Date(iso);
  return groupOf(iso) === 'Hoy'
    ? d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('es', { day: 'numeric', month: 'short' });
}

/** El agente de una conversación, si no es el de siempre: por su nombre en este runner. */
function agentOf(c: AssistantConversationSummary): string | null {
  if (c.agent === DEFAULT_ASSISTANT_AGENT) return null;
  return chat.agents.find((a) => a.id === c.agent)?.label ?? c.agent;
}

const groups = computed(() => {
  const q = query.value.trim().toLowerCase();
  const out: Array<{ label: string; items: AssistantConversationSummary[] }> = [];
  for (const c of history.items) {
    if (q && !c.title.toLowerCase().includes(q) && !scopeLabel(c.scope).toLowerCase().includes(q)) continue;
    const label = groupOf(c.updated_at);
    const group = out.at(-1)?.label === label ? out.at(-1) : undefined;
    if (group) group.items.push(c);
    else out.push({ label, items: [c] });
  }
  return out;
});

function fresh() {
  chat.newConversation();
  emit('picked');
}

async function pick(id: string) {
  confirming.value = null;
  if (id !== chat.conversationId) await history.open(id);
  emit('picked');
}
</script>

<template>
  <aside class="cl" aria-label="Conversaciones">
    <div class="cl__top">
      <button type="button" class="cl__new" data-test="new" :disabled="chat.streaming" @click="fresh">＋ Nueva conversación</button>
    </div>

    <template v-if="session.github">
      <div class="cl__search">
        <input v-model="query" type="search" class="cl__input" placeholder="Buscar en tus conversaciones" aria-label="Buscar en tus conversaciones" />
      </div>
      <nav class="cl__list">
        <p v-if="history.error" class="cl__err" role="alert">✕ {{ history.error }}</p>
        <p v-else-if="history.loading && !history.items.length" class="cl__dim">· cargando…</p>
        <p v-else-if="!groups.length" class="cl__dim">{{ query ? 'Nada con ese texto.' : 'Todavía no hay conversaciones guardadas.' }}</p>
        <template v-for="g in groups" :key="g.label">
          <p class="cl__group">{{ g.label }}</p>
          <div v-for="c in g.items" :key="c.id" class="cl__item" :aria-current="c.id === chat.conversationId">
            <button type="button" class="cl__row" :data-test="`conv-${c.id}`" @click="pick(c.id)">
              <span class="cl__title">{{ c.title }}</span>
              <span class="cl__meta"><ScopeTag :scope="c.scope" /><span v-if="agentOf(c)" class="cl__agent" data-test="agent">{{ agentOf(c) }}</span><span class="cl__time mono">{{ time(c.updated_at) }}</span></span>
            </button>
            <!-- Borrar: sólo la abierta, y confirmando en la misma fila. -->
            <p v-if="c.id === chat.conversationId && confirming === c.id" class="cl__confirm">
              <span>¿Borrarla?</span>
              <button type="button" class="btn" @click="confirming = null">No</button>
              <button type="button" class="btn btn--destructive" data-test="confirm-delete" @click="history.remove(c.id)">Borrar</button>
            </p>
            <button v-else-if="c.id === chat.conversationId" type="button" class="cl__del" :data-test="`delete-${c.id}`" @click="confirming = c.id">
              Borrar esta conversación
            </button>
          </div>
        </template>
      </nav>
    </template>
    <p v-else class="cl__dim cl__login">
      Tus conversaciones se guardan con tu usuario de GitHub.
      <button type="button" class="cl__link" @click="session.requestLogin()">Entrar</button>
    </p>
  </aside>
</template>

<style scoped>
.cl { display: flex; flex-direction: column; min-height: 0; height: 100%; background: var(--panel-alt); }
.cl__top { padding: 0.6rem; border-bottom: 1px solid var(--border); }
.cl__new {
  width: 100%;
  min-height: var(--tap-h);
  border: 1px solid var(--accent);
  border-radius: var(--radius);
  background: transparent;
  color: var(--accent);
  font-family: var(--font-body);
  font-size: var(--fs-body-sm);
  font-weight: 600;
  cursor: pointer;
}
.cl__new:hover:not(:disabled) { background: var(--accent); color: var(--panel); }
.cl__new:disabled { opacity: 0.5; cursor: default; }
.cl__search { padding: 0.5rem 0.6rem 0; }
.cl__input {
  box-sizing: border-box;
  width: 100%;
  min-height: var(--tap-h-sm);
  padding: 0 0.6rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel);
  color: var(--fg);
  font-size: var(--fs-input);
}
.cl__list { flex: 1; min-height: 0; overflow-y: auto; padding: 0.25rem 0 0.75rem; }
.cl__group { margin: 0.6rem 0.75rem 0.2rem; color: var(--fg-dim); font-family: var(--font-mono); font-size: var(--fs-micro); letter-spacing: var(--tracking-lbl); text-transform: uppercase; }
.cl__item { border-left: 3px solid transparent; }
.cl__item[aria-current='true'] { border-left-color: var(--accent); background: var(--panel-hi); }
.cl__row { display: flex; flex-direction: column; gap: 0.15rem; width: 100%; min-height: var(--tap-h); padding: 0.45rem 0.75rem; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.cl__row:hover { background: var(--panel-hi); }
.cl__row:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
.cl__title { display: -webkit-box; overflow: hidden; color: var(--fg); font-size: var(--fs-body-sm); line-height: 1.35; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow-wrap: anywhere; }
.cl__meta { display: flex; align-items: center; gap: 0.4rem; min-width: 0; }
.cl__agent { min-width: 0; overflow: hidden; color: var(--fg-dim); font-size: var(--fs-micro); text-overflow: ellipsis; white-space: nowrap; }
.cl__time { flex: none; margin-left: auto; color: var(--fg-dim); font-size: var(--fs-micro); }
.cl__del { min-height: var(--tap-h-sm); margin: 0 0 0.3rem 0.75rem; padding: 0; border: 0; background: none; color: var(--fg-dim); font-size: var(--fs-chrome); cursor: pointer; }
.cl__del:hover { color: var(--danger); text-decoration: underline; }
.cl__confirm { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; margin: 0; padding: 0 0.75rem 0.5rem; color: var(--fg); font-size: var(--fs-body-sm); }
.cl__dim { margin: 0; padding: 0.75rem; color: var(--fg-dim); font-size: var(--fs-body-sm); }
.cl__err { margin: 0; padding: 0.75rem; color: var(--danger); font-size: var(--fs-body-sm); }
.cl__link { min-height: var(--tap-h); padding: 0 0.25rem; border: 0; background: none; color: var(--info); font: inherit; text-decoration: underline; cursor: pointer; }
</style>
