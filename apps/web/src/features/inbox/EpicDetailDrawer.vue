<script setup lang="ts">
import type { EpicChild } from '@ia-flow/shared';
import { computed, onUnmounted, watch } from 'vue';
import { useBackClose } from '@/composables/useBackClose';
import RefLink from '@/features/inbox/decisions/RefLink.vue';
import { refUrl, shortRef } from '@/features/inbox/queue/shortRef';
import { useInboxStore } from '@/features/inbox/store';

// La épica abierta desde su chip (o desde «Dónde se traba cada épica»): su avance y TODOS sus
// sub-issues, con la columna de los que están en el board. Tocar un hijo del board abre su detalle;
// uno fuera del board (o cerrado), su issue en GitHub. Misma caja que el detalle de una tarea:
// pantalla entera en un teléfono, panel a la derecha desde --bp-shell.

const store = useInboxStore();

const state = computed(() => (store.epicRef ? store.epics[store.epicRef] : undefined));
const epic = computed(() => state.value?.data?.epic ?? null);
const children = computed(() => state.value?.data?.children ?? []);
const pct = computed(() => {
  const e = epic.value;
  return e && e.total > 0 ? Math.round((Math.min(e.done, e.total) / e.total) * 100) : 0;
});

/** Un hijo con columna es una card del board: su detalle se abre acá mismo. */
const onBoard = (child: EpicChild) => child.state === 'open' && child.status !== undefined;

function where(child: EpicChild): string {
  if (child.state === 'closed') return 'cerrado';
  return child.status ?? 'fuera del board';
}

function openChild(child: EpicChild) {
  store.closeEpic();
  store.expand(child.ref);
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') store.closeEpic();
}

function setLock(on: boolean) {
  if (typeof document === 'undefined') return;
  document.body.style.overflow = on ? 'hidden' : '';
  if (on) document.addEventListener('keydown', onKeydown);
  else document.removeEventListener('keydown', onKeydown);
}

watch(() => store.epicRef !== null, setLock, { immediate: true });
onUnmounted(() => setLock(false));
useBackClose(() => store.epicRef !== null, () => store.closeEpic());
</script>

<template>
  <Teleport to="body">
    <div v-if="store.epicRef" class="ed-backdrop" @click.self="store.closeEpic()">
      <section class="ed" role="dialog" aria-modal="true" :aria-label="`Épica ${store.epicRef}`" data-test="epic-drawer">
        <header class="ed__head">
          <button type="button" class="ed__close" aria-label="Volver a la bandeja" @click="store.closeEpic()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
          </button>
          <span class="ed__meta">
            <RefLink :short="shortRef(store.epicRef)" :url="epic?.url ?? refUrl(store.epicRef) ?? ''" />
          </span>
        </header>
        <div class="ed__body">
          <p class="ed__pill">épica<template v-if="epic"> · {{ epic.done }}/{{ epic.total }} cerrados</template></p>
          <h2 v-if="epic" class="ed__title">{{ epic.title }}</h2>
          <div v-if="epic" class="ed__bar" aria-hidden="true"><div class="ed__fill" :style="{ width: `${pct}%` }" /></div>

          <p v-if="state?.loading && !epic" class="ed__note">Leyendo los sub-issues…</p>
          <p v-if="state?.error" class="ed__note ed__note--bad" role="alert">{{ state.error }}</p>
          <p v-else-if="epic && children.length === 0" class="ed__note">Esta épica no tiene sub-issues.</p>

          <ul v-if="children.length" class="ed__list" aria-label="Sub-issues">
            <li v-for="child in children" :key="child.ref" class="ed__child" :data-state="child.state" data-test="epic-child">
              <component
                :is="onBoard(child) ? 'button' : 'a'"
                class="ed__row"
                v-bind="onBoard(child) ? { type: 'button' } : { href: child.url, target: '_blank', rel: 'noopener noreferrer' }"
                :title="onBoard(child) ? `Ver el detalle de ${child.ref}` : `Abrir ${child.ref} en GitHub`"
                @click="onBoard(child) && openChild(child)"
              >
                <span class="ed__glyph" aria-hidden="true">{{ child.state === 'closed' ? '✓' : '○' }}</span>
                <span class="ed__what">
                  <span class="ed__name">{{ child.title }}</span>
                  <span class="ed__sub">
                    <span class="mono">{{ shortRef(child.ref) }}</span>
                    <span class="ed__where">{{ where(child) }}</span>
                    <span v-if="child.pr" class="mono">PR #{{ child.pr.number }}</span>
                    <span v-if="child.blocked_by?.length" class="ed__wait">espera {{ child.blocked_by.map(shortRef).join(', ') }}</span>
                  </span>
                </span>
                <span v-if="!onBoard(child)" class="ed__out" aria-hidden="true">↗</span>
              </component>
            </li>
          </ul>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
/* Mobile primero (R8): la pantalla entera. */
.ed-backdrop { position: fixed; inset: 0; z-index: 75; display: flex; justify-content: flex-end; background: var(--scrim); }
.ed {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  min-height: 0;
  padding-top: env(safe-area-inset-top, 0px);
  border-left: 1px solid var(--border);
  background: var(--panel);
  animation: ed-in 150ms ease;
}
@keyframes ed-in {
  from { transform: translateX(1.5rem); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}
.ed__head { flex: 0 0 auto; display: flex; align-items: center; gap: 0.25rem; min-height: var(--tap-h); padding: 0 1rem 0 0.25rem; border-bottom: 1px solid var(--border-mute); }
.ed__meta { display: flex; flex: 1; align-items: center; min-width: 0; }
.ed__close { flex: none; display: grid; place-items: center; width: var(--tap-h); height: var(--tap-h); border: none; border-radius: var(--radius); background: none; color: var(--fg-mute); cursor: pointer; }
.ed__close svg { width: 1.25rem; height: 1.25rem; }
.ed__close:hover { background: var(--panel-hi); color: var(--fg); }
.ed__body { display: flex; flex-direction: column; gap: 0.5rem; flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 0.75rem 1rem 1rem; }
.ed__pill {
  align-self: flex-start;
  margin: 0;
  padding: 0.2rem 0.65rem;
  border: 1px solid color-mix(in srgb, var(--info) 35%, transparent);
  border-radius: 999px;
  color: var(--info);
  font-size: var(--fs-chrome);
  font-weight: 600;
}
.ed__title { margin: 0; color: var(--fg); font-size: var(--fs-num); line-height: 1.25; overflow-wrap: anywhere; }
.ed__bar { height: 0.3rem; overflow: hidden; border-radius: var(--radius-sm); background: var(--panel-hi); }
.ed__fill { height: 100%; background: var(--accent); }
.ed__note { margin: 0; color: var(--fg-dim); font-size: var(--fs-body-sm); }
.ed__note--bad { color: var(--danger); }
.ed__list { list-style: none; margin: 0.25rem 0 0; padding: 0; }
.ed__child { border-top: 1px solid var(--border-mute); }
.ed__row {
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
  width: 100%;
  min-height: var(--tap-h);
  padding: 0.5rem 0.25rem;
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--fg);
  font: inherit;
  text-align: left;
  text-decoration: none;
  cursor: pointer;
}
.ed__row:hover { background: var(--panel-hi); color: var(--fg); }
.ed__row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.ed__glyph { flex: none; width: 1rem; color: var(--fg-dim); line-height: 1.35; }
.ed__child[data-state='closed'] .ed__glyph { color: var(--accent); }
.ed__child[data-state='closed'] .ed__name { color: var(--fg-dim); }
.ed__what { display: flex; flex: 1; flex-direction: column; gap: 0.15rem; min-width: 0; }
.ed__name { line-height: 1.35; overflow-wrap: anywhere; }
.ed__sub { display: flex; flex-wrap: wrap; gap: 0 0.6rem; color: var(--fg-dim); font-size: var(--fs-chrome); }
.ed__where { color: var(--fg-mute); }
.ed__wait { color: var(--warn); }
.ed__out { flex: none; color: var(--fg-dim); }

@media (min-width: 768px) {
  .ed { width: min(40rem, 92vw); padding-top: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .ed { animation: none; }
}
</style>
