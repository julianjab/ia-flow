<script setup lang="ts">
import { computed } from 'vue';
import type { GithubIssue } from '@/features/github-search/api';
import AddToBoardMenu from '@/features/github-search/AddToBoardMenu.vue';
import type { AddOutcome, AddRequest, BoardEntry, BoardProject } from '@/features/github-search/board';

// Un resultado: el título, la ref, Abierto/Cerrado · issue/PR. Si ya está en el board dice su
// columna y tocarlo abre el detalle DENTRO de la app; un issue abierto que no está trae «Agregar al
// board ▾» (un PR no entra al board). Sólo el ↗ abre GitHub, en otra pestaña.

const props = defineProps<{
  issue: GithubIssue;
  /** Su tarea del board (o la del issue que abrió este PR); `null` si no está. */
  entry: BoardEntry | null;
  /** La columna en la que se acaba de agregar desde acá (sin esperar al board). */
  added: string | null;
  projects: readonly BoardProject[];
  add: (request: AddRequest) => Promise<AddOutcome>;
}>();
const emit = defineEmits<{ open: [ref: string]; added: [status: string] }>();

const status = computed(() => props.added ?? props.entry?.status ?? null);
const inBoard = computed(() => props.entry !== null || props.added !== null);
const taskRef = computed(() => props.entry?.ref ?? props.issue.ref);
const meta = computed(
  () => `${props.issue.open ? 'Abierto' : 'Cerrado'} · ${props.issue.isPR ? 'PR' : 'issue'}`,
);
</script>

<template>
  <li class="gr" :data-ref="issue.ref" data-test="result">
    <div class="gr__top">
      <button
        v-if="inBoard"
        type="button"
        class="gr__main gr__main--open"
        :aria-label="`Abrir ${taskRef} en ia-flow`"
        data-test="open"
        @click="emit('open', taskRef)"
      >
        <span class="gr__title">{{ issue.title }}</span>
        <span class="gr__meta"><span class="mono">{{ issue.ref }}</span> · {{ meta }}</span>
      </button>
      <div v-else class="gr__main">
        <span class="gr__title">{{ issue.title }}</span>
        <span class="gr__meta"><span class="mono">{{ issue.ref }}</span> · {{ meta }}</span>
      </div>
      <a
        class="gr__gh link"
        :href="issue.url"
        target="_blank"
        rel="noopener noreferrer"
        :aria-label="`Abrir ${issue.ref} en GitHub`"
        data-test="github"
        >↗</a
      >
    </div>
    <div class="gr__foot">
      <span v-if="inBoard" class="gr__chip" data-test="in-board">
        {{ status ? `En el board · ${status}` : 'En el board' }}
      </span>
      <AddToBoardMenu
        v-else-if="issue.open && !issue.isPR"
        :issue-ref="issue.ref"
        :projects="projects"
        :add="add"
        @added="emit('added', $event)"
      />
      <!-- Lo que el runner no deja entrar dice por qué, en vez de no ofrecer nada. -->
      <span v-else class="gr__why" data-test="not-addable">
        {{ issue.isPR ? 'Un PR no entra al board: se agrega el issue que cierra.' : 'Está cerrado: no entra al board.' }}
      </span>
    </div>
  </li>
</template>

<style scoped>
.gr { display: flex; flex-direction: column; gap: 0.25rem; padding: 0.4rem 0.5rem 0.5rem 0; }
.gr + .gr { border-top: 1px solid var(--border-mute); }
.gr__top { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 0.25rem; }
.gr__main {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  min-width: 0;
  min-height: var(--tap-h);
  justify-content: center;
  padding: 0.25rem 0.75rem;
  border: 0;
  background: none;
  color: var(--fg);
  font: inherit;
  text-align: left;
}
.gr__main--open { cursor: pointer; border-radius: var(--radius-sm); }
.gr__main--open:hover .gr__title { color: var(--info); }
.gr__main--open:focus-visible { outline: 2px solid var(--primary); outline-offset: -2px; }
.gr__title { overflow-wrap: anywhere; line-height: 1.35; }
.gr__meta { color: var(--fg-dim); font-size: var(--fs-chrome); overflow-wrap: anywhere; }
.gr__meta .mono { font-size: var(--fs-micro); }
.gr__gh { display: grid; place-items: center; width: var(--tap-h); height: var(--tap-h); }
.gr__foot { padding: 0 0.75rem; }
.gr__chip {
  display: inline-flex;
  align-items: center;
  padding: 0.15rem 0.55rem;
  border-radius: 999px;
  background: var(--blue-bg);
  color: var(--blue);
  font-size: var(--fs-chrome);
}
.gr__why { color: var(--fg-dim); font-size: var(--fs-chrome); }
</style>
