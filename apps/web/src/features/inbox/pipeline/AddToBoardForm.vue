<script setup lang="ts">
import type { AddToBoardResult, InboxProject } from '@ia-flow/shared';
import { computed, ref, useId, watch } from 'vue';
import ActionError from '@/features/inbox/decisions/ActionError.vue';
import { tokenOrLogin } from '@/features/inbox/githubToken';
import { actionFailure } from '@/features/inbox/queue/advice';
import { defaultColumn } from '@/features/inbox/queue/columns';
import { useInboxStore } from '@/features/inbox/store';
import { useGithubSessionStore } from '@/stores/githubSession';

// Al pie del feed: un issue que todavía no está en el board entra, en la columna que elijas (Todo
// por default). Se escribe `owner/repo#n` o se pega el link. El proyecto se elige sólo si hay más
// de uno; la columna, sólo si el runner manda las columnas (si no, entra en Todo). Firmado con tu
// usuario de GitHub: sin sesión, el botón invita a iniciarla. El error del runner (ya está en el
// board, es un PR…) queda abajo, con «Reintentar».

const props = defineProps<{
  projects: readonly InboxProject[];
  /** El proyecto que se está mirando: el default cuando hay más de uno. */
  project?: string | null;
}>();

const store = useInboxStore();
const session = useGithubSessionStore();
const id = useId();

const issue = ref('');
const projectId = ref(props.project ?? props.projects[0]?.id ?? '');
const statuses = computed(() => props.projects.find((p) => p.id === projectId.value)?.statuses ?? []);
const column = ref(defaultColumn(statuses.value) ?? '');
watch(statuses, (next) => {
  if (!next.includes(column.value)) column.value = defaultColumn(next) ?? '';
});

const pending = ref(false);
const outcome = ref<{ result: AddToBoardResult | null; error: string | null } | null>(null);
const failure = computed(() => {
  const o = outcome.value;
  const message = o?.error ?? (o?.result && !o.result.ok ? o.result.message : null);
  return message ? actionFailure('Agregar al board', message) : null;
});
const done = computed(() => (outcome.value?.result?.ok ? outcome.value.result : null));

const signedIn = computed(() => Boolean(session.github));
const label = computed(() => {
  if (pending.value) return '· agregando';
  return signedIn.value ? 'Agregar' : 'Iniciá sesión para agregar';
});

async function submit(): Promise<void> {
  const text = issue.value.trim();
  if (pending.value) return;
  outcome.value = null;
  if (!signedIn.value) {
    session.requestLogin();
    return;
  }
  if (!text) return;
  const token = await tokenOrLogin();
  if (!token) return;
  pending.value = true;
  try {
    outcome.value = await store.addToBoard(
      {
        issue: text,
        ...(projectId.value ? { project_id: projectId.value } : {}),
        ...(column.value ? { status: column.value } : {}),
      },
      token,
    );
    if (outcome.value.result?.ok) issue.value = '';
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <form class="add" data-test="add-to-board" @submit.prevent="submit">
    <label class="uc-label" :for="id">Agregar al board</label>
    <div class="add__row">
      <input
        :id="id"
        v-model="issue"
        class="ff-field ff-mono add__issue"
        type="text"
        placeholder="owner/repo#123 o el link del issue"
        autocomplete="off"
        spellcheck="false"
        :disabled="pending"
      />
      <select v-if="projects.length > 1" v-model="projectId" class="ff-field add__pick" aria-label="Proyecto" :disabled="pending">
        <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.id }}</option>
      </select>
      <select v-if="statuses.length" v-model="column" class="ff-field add__pick" aria-label="Columna" :disabled="pending">
        <option v-for="s in statuses" :key="s" :value="s">{{ s }}</option>
      </select>
      <button type="submit" class="btn add__go" :disabled="pending || (signedIn && !issue.trim())">{{ label }}</button>
    </div>
    <ActionError v-if="failure" :failure="failure" :busy="pending" @retry="submit" />
    <p v-else-if="done" class="add__ok" role="status">
      ✓ {{ done.message }}<template v-if="done.github_login"> · @{{ done.github_login }}</template>
    </p>
  </form>
</template>

<style scoped src="@/ui/form-fields.css" />
<style scoped>
.add { display: flex; flex-direction: column; gap: 0.35rem; padding: 0.6rem 0.75rem; border-top: 1px solid var(--border-mute); }
.add__row { display: flex; flex-wrap: wrap; gap: 0.4rem; }
/* En el teléfono el issue ocupa su línea y los selectores y el botón van debajo. */
.add__issue { flex: 1 1 100%; min-width: 0; }
.add__pick { flex: 1 1 8rem; width: auto; min-width: 0; }
.add__go { flex: none; }
.add__ok { margin: 0; color: var(--accent); font-size: var(--fs-body-sm); }
@media (min-width: 640px) {
  .add { padding-left: 1rem; }
  .add__issue { flex: 1 1 14rem; }
  .add__pick { flex: 0 1 10rem; }
}
</style>
