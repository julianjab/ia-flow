<script setup lang="ts">
import { computed } from 'vue';
import { type HealthSnapshot, type Issue, toLook, toLookTitle, type Verdict } from '@/features/runner-health/status';

// Arriba de todo, primero lo que está mal: «N cosas para mirar» con cada una, o «Todo bien». El
// veredicto (el del menú de Mac) va en la línea de abajo, con la versión y cuánto tardó. Las notas
// (este runner no expone tal endpoint) van aparte, apagadas: no son algo roto.

const props = defineProps<{ snapshot: HealthSnapshot; issues: Issue[]; verdict: Verdict }>();

/** Cuando todo está mal el aviso se acorta (R15): tres y la cuenta del resto. */
const SHOWN = 3;
const look = computed(() => toLook(props.issues));
const notes = computed(() => props.issues.filter((i) => i.tone === 'info'));
const title = computed(() => (look.value.length ? toLookTitle(look.value.length) : props.verdict.title));
const meta = computed(() =>
  [
    title.value === props.verdict.title ? undefined : props.verdict.title,
    props.snapshot.info ? `v${props.snapshot.info.version}` : undefined,
    props.snapshot.latencyMs !== undefined ? `${props.snapshot.latencyMs} ms` : undefined,
  ]
    .filter(Boolean)
    .join(' · '),
);
</script>

<template>
  <section class="hs" :class="`hs--${verdict.tone}`" aria-live="polite" data-test="summary">
    <h2 class="hs__title">{{ title }}</h2>
    <p v-if="meta" class="hs__meta" data-test="verdict">{{ meta }}</p>
    <ul v-if="look.length" class="hs__list">
      <li v-for="issue in look.slice(0, SHOWN)" :key="issue.text" :class="`hs__issue--${issue.tone}`">{{ issue.text }}</li>
      <li v-if="look.length > SHOWN" class="hs__more">y {{ look.length - SHOWN }} más</li>
    </ul>
    <p v-for="note in notes" :key="note.text" class="hs__note">{{ note.text }}</p>
  </section>
</template>

<style scoped>
.hs {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  padding: 0.85rem 1rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--green-bg);
}
.hs--warn { border-color: var(--warn); background: var(--yellow-bg); }
.hs--bad { border-color: var(--danger); background: var(--red-bg); }
.hs__title { margin: 0; font-size: var(--fs-body); font-weight: 600; }
.hs__meta { margin: 0; color: var(--fg-dim); font-size: var(--fs-chrome); }
.hs__list { display: flex; flex-direction: column; gap: 0.25rem; margin: 0.2rem 0 0; padding: 0; list-style: none; color: var(--fg-mute); }
.hs__list li { overflow-wrap: anywhere; }
.hs__issue--bad::before { content: '✕ '; color: var(--danger); }
.hs__issue--warn::before { content: '! '; color: var(--warn); font-weight: 700; }
.hs__more { color: var(--fg-dim); font-size: var(--fs-chrome); }
.hs__note { margin: 0; color: var(--fg-dim); font-size: var(--fs-chrome); }
</style>
