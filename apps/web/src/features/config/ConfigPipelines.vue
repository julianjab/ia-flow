<script setup lang="ts">
import type { ConfigSummary } from '@ia-flow/shared';
import { computed } from 'vue';

// Las pipelines de cada fuente —la global del runner y una por proyecto—, en el
// orden en que el engine las evalúa. Cada una, plegada: qué escucha y qué corre;
// abierta, sus condiciones una por renglón, escritas como en el YAML.

const props = defineProps<{ pipelines: ConfigSummary['pipelines']; source: string | null }>();

const groups = computed(() => {
  const bySource = new Map<string, ConfigSummary['pipelines']>();
  for (const p of props.pipelines) {
    if (props.source && p.source_id !== props.source && p.source_id !== 'runner') continue;
    bySource.set(p.source_id, [...(bySource.get(p.source_id) ?? []), p]);
  }
  // La global primero: recibe todos los eventos y los traduce para los proyectos.
  return [...bySource.entries()]
    .sort(([a], [b]) => (a === 'runner' ? -1 : b === 'runner' ? 1 : a.localeCompare(b)))
    .map(([source, list]) => ({ source, list: [...list].sort((a, b) => a.position - b.position) }));
});
</script>

<template>
  <section v-for="g in groups" :key="g.source" class="cp" :aria-label="`Pipelines de ${g.source}`">
    <h2 class="cp__hd">
      {{ g.source === 'runner' ? 'Global' : g.source }}
      <span class="cp__n mono">{{ g.list.length }}</span>
      <span class="cp__hint">{{ g.source === 'runner' ? 'recibe todos los eventos' : 'sólo los eventos de este proyecto' }}</span>
    </h2>
    <ul class="cp__list">
      <li v-for="p in g.list" :key="p.id">
        <details class="cp__item">
          <summary class="cp__row">
            <span class="cp__chev" aria-hidden="true">▸</span>
            <span class="cp__main">
              <span class="cp__line">
                <span class="mono cp__id">{{ p.id }}</span>
                <span v-if="p.exclusive" class="cp__tag">exclusive</span>
                <span class="cp__dim mono">{{ p.on.join(' · ') }}</span>
              </span>
              <span v-if="p.name" class="cp__name">{{ p.name }}</span>
              <span class="cp__steps">
                <span v-for="a in p.agents" :key="`a-${a}`" class="cp__agent mono">{{ a }}</span>
                <span v-for="a in p.actions" :key="`x-${a}`" class="cp__action mono">{{ a }}</span>
              </span>
            </span>
          </summary>
          <div class="cp__body">
            <p class="uc-label">corre cuando</p>
            <ul v-if="p.when.length" class="cp__when">
              <li v-for="(w, i) in p.when" :key="i" class="mono">{{ w }}</li>
            </ul>
            <p v-else class="cp__dim">· siempre que llega uno de sus eventos</p>
          </div>
        </details>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.cp { display: flex; flex-direction: column; gap: 0.35rem; }
.cp__hd { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.25rem 0.6rem; margin: 0; font-size: var(--fs-body); text-transform: uppercase; letter-spacing: var(--tracking-hd); }
.cp__n { color: var(--fg-dim); font-size: var(--fs-chrome); }
.cp__hint { margin-left: auto; color: var(--fg-dim); font-family: var(--font-body); font-size: var(--fs-body-sm); font-weight: 400; letter-spacing: 0; text-transform: none; }
.cp__list { margin: 0; padding: 0; list-style: none; border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel); }
.cp__list > li + li { border-top: 1px solid var(--border-mute); }
.cp__row { display: flex; align-items: flex-start; gap: 0.5rem; min-height: var(--tap-h); padding: 0.5rem 0.75rem; cursor: pointer; list-style: none; }
.cp__row::-webkit-details-marker { display: none; }
.cp__row:hover { background: var(--panel-alt); }
.cp__row:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
.cp__chev { flex: none; color: var(--fg-dim); font-size: var(--fs-micro); line-height: 1.8; transition: transform 120ms ease; }
.cp__item[open] .cp__chev { transform: rotate(90deg); }
.cp__main { display: flex; flex-direction: column; gap: 0.2rem; min-width: 0; }
.cp__line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.2rem 0.6rem; }
.cp__id { color: var(--fg); font-size: var(--fs-body-sm); }
.cp__tag { line-height: var(--row-h); padding: 0 0.4rem; border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--fg-dim); font-family: var(--font-mono); font-size: var(--fs-micro); }
.cp__dim { margin: 0; color: var(--fg-dim); font-size: var(--fs-chrome); overflow-wrap: anywhere; }
.cp__name { color: var(--fg-mute); font-size: var(--fs-body-sm); overflow-wrap: anywhere; }
.cp__steps { display: flex; flex-wrap: wrap; gap: 0.3rem; }
/* Un agente y una action se distinguen por el color del texto, en la misma caja. */
.cp__agent,
.cp__action { line-height: var(--row-h); padding: 0 0.4rem; border-radius: var(--radius-sm); background: var(--panel-hi); font-size: var(--fs-micro); }
.cp__agent { color: var(--accent); }
.cp__action { color: var(--info); }
.cp__body { display: flex; flex-direction: column; gap: 0.3rem; padding: 0 0.75rem 0.75rem 2rem; }
.cp__body .uc-label { margin: 0; }
.cp__when { display: flex; flex-direction: column; gap: 0.2rem; margin: 0; padding: 0; list-style: none; color: var(--fg-mute); font-size: var(--fs-chrome); overflow-wrap: anywhere; }
</style>
