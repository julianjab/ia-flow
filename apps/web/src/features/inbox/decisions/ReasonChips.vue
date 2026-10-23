<script setup lang="ts">
import type { Reason } from '@/features/inbox/queue/entries';
import { useInboxStore } from '@/features/inbox/store';

// Por qué una decisión está en su lugar: los chips del dashboard (o los que se deducen con un
// runner viejo). No son presionables: miden `--row-h`, y el tono (hot/warn/bad) va en el texto y
// en un fondo de estado sin borde — la excepción documentada en DESIGN_SYSTEM «Chip / tag».
// Un chip nunca rompe en dos líneas: si no entra, se corta con «…» y el texto entero va en `title`.
// El de la épica sí navega: abre la épica con sus sub-issues, y su blanco táctil es `--tap-h-sm`.

defineProps<{ reasons: readonly Reason[] }>();

const store = useInboxStore();
</script>

<template>
  <template v-for="r in reasons" :key="r.text">
    <button
      v-if="r.epic"
      type="button"
      class="why-btn"
      :title="r.full ?? r.text"
      :aria-label="`Ver la ${r.full ?? r.text} con sus sub-issues`"
      data-test="epic-chip"
      @click.stop="store.openEpic(r.epic)"
    >
      <span class="why why--epic">{{ r.text }}</span>
    </button>
    <span v-else class="why" :data-tone="r.tone" :title="r.full ?? r.text">{{ r.text }}</span>
  </template>
</template>

<style scoped>
.why {
  line-height: var(--row-h);
  padding: 0 0.5rem;
  border-radius: 999px;
  background: var(--panel-hi);
  color: var(--fg-mute);
  font-size: var(--fs-chrome);
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: middle;
}
.why[data-tone='hot'] { background: var(--green-bg); color: var(--accent); }
.why[data-tone='warn'] { background: var(--yellow-bg); color: var(--warn); }
.why[data-tone='bad'] { background: var(--red-bg); color: var(--danger); }
/* El blanco táctil es el botón; la pastilla de adentro se ve igual que las demás razones. */
.why-btn {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  min-height: var(--tap-h-sm);
  padding: 0;
  border: none;
  background: none;
  font: inherit;
  cursor: pointer;
  vertical-align: middle;
}
.why--epic { color: var(--info); }
.why-btn:hover .why--epic { color: var(--fg); text-decoration: underline; }
.why-btn:focus-visible { outline: none; }
.why-btn:focus-visible .why--epic { outline: 2px solid var(--primary); outline-offset: 1px; }
</style>
