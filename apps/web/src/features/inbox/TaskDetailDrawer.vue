<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { useBackClose } from '@/composables/useBackClose';
import RefLink from '@/features/inbox/decisions/RefLink.vue';
import { KIND_LABEL } from '@/features/inbox/labels';
import { TYPE_META, typeOf } from '@/features/inbox/queue/kinds';
import { shortRef } from '@/features/inbox/queue/shortRef';
import { useInboxStore } from '@/features/inbox/store';
import TaskDetailPanel from '@/features/inbox/TaskDetailPanel.vue';

// El detalle de una tarea en grande: la traza entera en vivo y todos los
// eventos, con el ancho que la tarjeta no tiene. Sobre 768px es un panel a la
// derecha (la bandeja se sigue viendo al costado); abajo, la pantalla entera.
// Es la tarea abierta del store: lo que llega por el stream le llega acá igual. El tono va por
// TIPO (glifo y caso en la cabecera), como en la cola; nada de borde por grupo.

const store = useInboxStore();

const item = computed(() => {
  const ref = store.openRef;
  if (!store.expanded || !ref) return null;
  return store.details[ref]?.data?.item ?? store.inbox?.items.find((i) => i.ref === ref) ?? null;
});

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') store.collapse();
}

// El fondo no scrollea mientras el panel está abierto: el gesto se queda en el panel.
function setLock(on: boolean) {
  if (typeof document === 'undefined') return;
  document.body.style.overflow = on ? 'hidden' : '';
  if (on) document.addEventListener('keydown', onKeydown);
  else document.removeEventListener('keydown', onKeydown);
}

const meta = computed(() => (item.value ? TYPE_META[typeOf(item.value)] : null));
const tone = computed(() => (meta.value ? { '--tone': `var(--${meta.value.tone})` } : {}));
/** El porqué, salvo que repita lo que ya está a la vista: el caso de la pastilla o el error de su
 *  ejecución (una sola vez). */
const why = computed(() => {
  const it = item.value;
  if (!it) return '';
  return it.why === it.execution?.failure?.message || it.why === KIND_LABEL[it.kind] ? '' : it.why;
});

watch(() => item.value !== null, setLock, { immediate: true });
onUnmounted(() => setLock(false));
// El «atrás» del teléfono (o del navegador) vuelve a la bandeja, no a la pantalla anterior.
useBackClose(() => item.value !== null, () => store.collapse());

/** De qué tarea se vino al saltar a otra desde el detalle («Bloqueada por»): el «atrás» vuelve a ella. */
const from = ref<string | null>(null);
let restoring = false;
watch(
  () => (store.expanded ? store.openRef : null),
  (now, before) => {
    if (!now) from.value = null;
    else if (restoring) restoring = false;
    else if (before && now !== before) from.value = before;
  },
);
useBackClose(
  () => from.value !== null,
  () => {
    const back = from.value;
    from.value = null;
    if (!back) return;
    restoring = true;
    store.expand(back);
  },
);
</script>

<template>
  <Teleport to="body">
    <div v-if="item" class="dd-backdrop" @click.self="store.collapse()">
      <section class="dd" role="dialog" aria-modal="true" :aria-label="`Detalle de ${item.ref}`">
        <header class="dd__head">
          <button type="button" class="dd__close" aria-label="Volver a la bandeja" @click="store.collapse()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
          </button>
          <span class="dd__meta"><RefLink :short="shortRef(item.ref)" :url="item.url" /></span>
        </header>
        <div class="dd__body">
          <p class="dd__pill" :style="tone">
            <span v-if="meta" aria-hidden="true">{{ meta.glyph }}</span>
            {{ KIND_LABEL[item.kind] }}<template v-if="item.status"> · {{ item.status }}</template>
          </p>
          <h2 class="dd__title">{{ item.title }}</h2>
          <p v-if="why" class="dd__why">{{ why }}</p>
          <TaskDetailPanel :item="item" :detail="store.details[item.ref]" @reload="store.loadDetail(item.ref)" />
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
/* Mobile primero (R8): la pantalla entera. */
.dd-backdrop { position: fixed; inset: 0; z-index: 75; display: flex; justify-content: flex-end; background: var(--scrim); }
.dd {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  min-height: 0;
  padding-top: env(safe-area-inset-top, 0px);
  border-left: 1px solid var(--border);
  background: var(--panel);
  animation: dd-in 150ms ease;
}
@keyframes dd-in {
  from { transform: translateX(1.5rem); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}
.dd__head { flex: 0 0 auto; display: flex; align-items: center; gap: 0.25rem; min-height: var(--tap-h); padding: 0 1rem 0 0.25rem; border-bottom: 1px solid var(--border-mute); }
.dd__meta { display: flex; flex: 1; align-items: center; min-width: 0; }
.dd__close { flex: none; display: grid; place-items: center; width: var(--tap-h); height: var(--tap-h); border: none; border-radius: var(--radius); background: none; color: var(--fg-mute); cursor: pointer; }
.dd__close svg { width: 1.25rem; height: 1.25rem; }
.dd__close:hover { background: var(--panel-hi); color: var(--fg); }
/* El caso como pastilla: glifo y color del tipo, en minúscula normal (antes, caja alta en la cabecera). */
.dd__pill {
  --tone: var(--fg-mute);
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  margin: 0 1rem 0.5rem;
  padding: 0.2rem 0.65rem;
  border: 1px solid color-mix(in srgb, var(--tone) 35%, transparent);
  border-radius: 999px;
  color: var(--tone);
  font-size: var(--fs-chrome);
  font-weight: 600;
}
/* Sólo el cuerpo scrollea: la cabecera con el ✕ queda a mano. */
.dd__body { display: flex; flex-direction: column; align-items: flex-start; flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 0.75rem 0 0; }
.dd__body > * { align-self: stretch; }
.dd__body > .dd__pill { align-self: flex-start; }
.dd__title { margin: 0; padding: 0 1rem; color: var(--fg); font-size: var(--fs-num); line-height: 1.25; overflow-wrap: anywhere; }
.dd__why { margin: 0.25rem 0 0; padding: 0 1rem; color: var(--fg-mute); font-size: var(--fs-body-sm); overflow-wrap: anywhere; }
/* El detalle ya trae su borde de arriba: acá es el cuerpo del panel. */
.dd__body :deep(.td) { border-top: 0; padding: 0.75rem 1rem 0; }

/* Sobre --bp-shell: un panel a la derecha, ancho para leer una traza, con la bandeja al costado. */
@media (min-width: 768px) {
  .dd { width: min(60rem, 92vw); padding-top: 0; animation-duration: 150ms; }
}
@media (prefers-reduced-motion: reduce) {
  .dd { animation: none; }
}
</style>
