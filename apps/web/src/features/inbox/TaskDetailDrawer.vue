<script setup lang="ts">
import { computed, onUnmounted, watch } from 'vue';
import { KIND_LABEL } from '@/features/inbox/labels';
import { useInboxStore } from '@/features/inbox/store';
import TaskDetailPanel from '@/features/inbox/TaskDetailPanel.vue';

// El detalle de una tarea en grande: la traza entera en vivo y todos los
// eventos, con el ancho que la tarjeta no tiene. Sobre 768px es un panel a la
// derecha (la bandeja se sigue viendo al costado); abajo, la pantalla entera.
// Es la tarea abierta del store: lo que llega por el stream le llega acá igual.

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

watch(() => item.value !== null, setLock, { immediate: true });
onUnmounted(() => setLock(false));
</script>

<template>
  <Teleport to="body">
    <div v-if="item" class="dd-backdrop" @click.self="store.collapse()">
      <section class="dd" role="dialog" aria-modal="true" :aria-label="`Detalle de ${item.ref}`" :data-group="item.group">
        <header class="dd__head">
          <span class="dd__meta">
            <span class="dd__kind">{{ KIND_LABEL[item.kind] }}</span>
            <span class="dd__ref mono">{{ item.ref }}</span>
            <span v-if="item.status" class="dd__chip mono">{{ item.status }}</span>
          </span>
          <button type="button" class="dd__close" aria-label="Cerrar el detalle" @click="store.collapse()">✕</button>
        </header>
        <div class="dd__body">
          <h2 class="dd__title">{{ item.title }}</h2>
          <p class="dd__why">{{ item.why }}</p>
          <TaskDetailPanel :item="item" :detail="store.details[item.ref]" full @reload="store.loadDetail(item.ref)" />
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
/* Mobile primero (R8): la pantalla entera. */
.dd-backdrop { position: fixed; inset: 0; z-index: 75; display: flex; justify-content: flex-end; background: rgba(0, 0, 0, 0.6); }
.dd {
  --c: var(--fg-mute);
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  min-height: 0;
  padding-top: env(safe-area-inset-top, 0px);
  border-left: 3px solid var(--c);
  background: var(--panel);
  animation: dd-in 150ms ease;
}
.dd[data-group='need'] { --c: var(--warn); }
.dd[data-group='fail'] { --c: var(--danger); }
.dd[data-group='run'] { --c: var(--accent); }
@keyframes dd-in {
  from { transform: translateX(1.5rem); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}
.dd__head { flex: 0 0 auto; display: flex; align-items: center; gap: 0.5rem; min-height: var(--tap-h); padding: 0 0.35rem 0 1rem; border-bottom: 1px solid var(--border); }
.dd__meta { display: flex; flex: 1; flex-wrap: wrap; align-items: center; gap: 0.1rem 0.6rem; min-width: 0; }
.dd__kind { color: var(--c); font-size: var(--fs-chrome); font-weight: 600; text-transform: uppercase; letter-spacing: var(--tracking-lbl); }
.dd__ref { color: var(--fg); font-size: var(--fs-chrome); }
.dd__chip { line-height: var(--row-h); padding: 0 0.4rem; border-radius: var(--radius-sm); background: var(--panel-hi); color: var(--fg-mute); font-size: var(--fs-micro); }
.dd__close { flex: none; width: var(--tap-h); height: var(--tap-h); border: none; background: none; color: var(--fg-dim); font-family: var(--font-mono); font-size: var(--fs-body-sm); cursor: pointer; }
.dd__close:hover { color: var(--fg); }
/* Sólo el cuerpo scrollea: la cabecera con el ✕ queda a mano. */
.dd__body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 0.75rem 0 calc(1rem + env(safe-area-inset-bottom, 0px)); }
.dd__title { margin: 0; padding: 0 1rem; color: var(--fg); font-size: var(--fs-body); overflow-wrap: anywhere; }
.dd__why { margin: 0.25rem 0 0; padding: 0 1rem; color: var(--fg-mute); font-size: var(--fs-body-sm); overflow-wrap: anywhere; }
/* El detalle ya trae su borde de arriba: acá es el cuerpo del panel. */
.dd__body :deep(.td) { border-top: 0; padding: 0.75rem 1rem 0; }

/* Sobre --bp-shell: un panel a la derecha, ancho para leer una traza, con la bandeja al costado. */
@media (min-width: 768px) {
  .dd { width: min(60rem, 92vw); padding-top: 0; animation-duration: 150ms; }
}
</style>
