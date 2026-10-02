<script setup lang="ts">
import type { InboxItem, TaskAction } from '@ia-flow/shared';
import { computed, ref } from 'vue';
import { ACTION_LABEL, confirmText, primaryAction } from '@/features/inbox/labels';
import { useInboxStore } from '@/features/inbox/store';
import { useGithubSessionStore } from '@/stores/githubSession';

// Las acciones que el runner ofrece sobre UNA tarea (`item.actions`), con
// confirmación en la página —no `window.confirm`— y firmadas con el login de
// GitHub del usuario. Sin login no sale ninguna request: se pide el login.
//
// Orden en la fila (DESIGN_SYSTEM «Botones»): neutro → primario → peligroso.

const props = defineProps<{ item: InboxItem }>();

const store = useInboxStore();
const session = useGithubSessionStore();

/** La acción esperando confirmación; `null` = ninguna. */
const pending = ref<TaskAction | null>(null);
const comment = ref('');
const needLogin = ref(false);

const state = computed(() => store.actions[props.item.ref]);
const busy = computed(() => state.value?.pending === true);
const needsComment = computed(() => props.item.actions.includes('answer_and_unblock'));

const ordered = computed(() => {
  const primary = primaryAction(props.item.kind);
  const rank = (a: TaskAction) => (a === primary ? 1 : a === 'stop' ? 2 : 0);
  return [...props.item.actions].sort((a, b) => rank(a) - rank(b));
});

function variant(action: TaskAction): string {
  if (action === primaryAction(props.item.kind)) return 'btn--primary';
  return action === 'stop' ? 'btn--danger' : '';
}

function blocked(action: TaskAction): boolean {
  return busy.value || (action === 'answer_and_unblock' && !comment.value.trim());
}

function ask(action: TaskAction) {
  store.clearAction(props.item.ref);
  if (!session.github) {
    needLogin.value = true;
    pending.value = null;
    return;
  }
  needLogin.value = false;
  pending.value = action;
}

async function confirm() {
  const action = pending.value;
  if (!action || !session.github) return;
  pending.value = null;
  // Renovado si está por vencer; si ya no se puede renovar, la sesión se cerró: pedir el login.
  const token = await session.token();
  if (!token) {
    needLogin.value = true;
    return;
  }
  const text = action === 'answer_and_unblock' ? comment.value.trim() : undefined;
  const result = await store.runAction(props.item.ref, action, token, text);
  if (result?.ok && action === 'answer_and_unblock') comment.value = '';
}
</script>

<template>
  <div v-if="item.actions.length" class="ta">
    <div v-if="needsComment" class="ta__reply">
      <label class="uc-label" :for="`reply-${item.ref}`">tu respuesta</label>
      <textarea
        :id="`reply-${item.ref}`"
        v-model="comment"
        class="ta__text"
        rows="3"
        placeholder="Se publica como comentario, se quita blocked y la tarea vuelve a su etapa"
        :disabled="busy"
      />
    </div>

    <div class="ta__row">
      <button
        v-for="action in ordered"
        :key="action"
        type="button"
        class="btn"
        :class="variant(action)"
        :disabled="blocked(action)"
        :data-action="action"
        @click="ask(action)"
      >
        {{ ACTION_LABEL[action] }}
      </button>
    </div>

    <div v-if="pending" class="ta__confirm" role="alertdialog" :aria-label="confirmText(pending, item.ref)">
      <p class="ta__ask">{{ confirmText(pending, item.ref) }}</p>
      <div class="ta__row">
        <button type="button" class="btn" @click="pending = null">Cancelar</button>
        <button type="button" class="btn btn--primary" data-test="confirm" @click="confirm">
          Confirmar
        </button>
      </div>
    </div>

    <div v-if="needLogin && !session.github" class="ta__login" role="alert">
      <p class="ta__ask">→ Iniciá sesión con GitHub para actuar: la acción queda firmada con tu usuario.</p>
      <button type="button" class="btn btn--primary" data-test="login" @click="session.requestLogin()">
        Iniciar sesión con GitHub
      </button>
    </div>

    <p v-if="busy" class="ta__msg">· ejecutando…</p>
    <p v-else-if="state?.result?.ok" class="ta__msg ta__msg--ok" role="status">
      ✓ {{ state.result.message }}<template v-if="state.result.github_login"> · @{{ state.result.github_login }}</template>
    </p>
    <p v-else-if="state?.result || state?.error" class="ta__msg ta__msg--err" role="alert">
      ✕ {{ state.result?.message ?? state.error }}
    </p>
  </div>
</template>

<style scoped>
.ta { display: flex; flex-direction: column; gap: 0.6rem; }
.ta__reply { display: flex; flex-direction: column; gap: 0.25rem; }
.ta__text {
  width: 100%;
  min-height: 4.5rem;
  resize: vertical;
  font-family: var(--font-body);
  font-size: var(--fs-body-sm);
  line-height: 1.45;
}
.ta__row { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.ta__confirm,
.ta__login {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.6rem 0.75rem;
  border: 1px solid var(--border-hi);
  border-radius: var(--radius);
  background: var(--panel-alt);
}
.ta__ask { margin: 0; color: var(--fg); font-size: var(--fs-body-sm); line-height: 1.45; }
.ta__login .btn { align-self: flex-start; }
.ta__msg { margin: 0; color: var(--fg-dim); font-size: var(--fs-body-sm); }
.ta__msg--ok { color: var(--accent); }
.ta__msg--err { color: var(--danger); }
</style>
