<script setup lang="ts">
import type { InboxItem } from '@ia-flow/shared';
import { computed, ref } from 'vue';
import { SNOOZE_CHOICES } from '@/features/inbox/queue/arrange';
import { useInboxStore } from '@/features/inbox/store';

// Lo que quien mira hace con el LUGAR de una decisión, no con la tarea: posponerla (sale de «Para
// mí» hasta que cambie algo o hasta un plazo) o fijarla arriba. Va dentro de la card abierta y en
// «Lo primero»; deslizar la fila es el atajo de lo mismo (R7: el gesto nunca es el único camino).

const props = defineProps<{ item: InboxItem }>();
const store = useInboxStore();

const menuOpen = ref(false);
const picking = ref(false);
const date = ref('');
const pinned = computed(() => store.isPinned(props.item.ref));
/** Mañana como mínimo: posponer «hasta hoy» no posterga nada. */
const minDate = computed(() => new Date(Date.now() + 24 * 3600_000).toISOString().slice(0, 10));

function choose(ms: number | null) {
  store.snooze(props.item, ms === null ? null : Date.now() + ms);
  menuOpen.value = false;
}

function chooseDate() {
  if (!date.value) return;
  store.snooze(props.item, Date.parse(`${date.value}T09:00:00`));
  menuOpen.value = false;
  picking.value = false;
}
</script>

<template>
  <div class="aa">
    <button
      type="button"
      class="btn btn--ghost"
      :aria-expanded="menuOpen"
      aria-haspopup="true"
      data-test="snooze"
      @click="menuOpen = !menuOpen"
    >
      Posponer {{ menuOpen ? '▴' : '▾' }}
    </button>
    <button type="button" class="btn btn--ghost" :aria-pressed="pinned" data-test="pin" @click="store.togglePin(item.ref)">
      {{ pinned ? 'Quitar de arriba' : 'Fijar arriba' }}
    </button>

    <div v-if="menuOpen" class="aa__menu" role="group" :aria-label="`Posponer «${item.title}»`">
      <button v-for="c in SNOOZE_CHOICES" :key="c.id" type="button" class="btn aa__opt" :data-test="`snooze-${c.id}`" @click="choose(c.ms)">
        {{ c.label }}
      </button>
      <button v-if="!picking" type="button" class="btn aa__opt" data-test="snooze-date" @click="picking = true">Elegir fecha…</button>
      <span v-else class="aa__date">
        <input v-model="date" type="date" :min="minDate" aria-label="Posponer hasta" />
        <button type="button" class="btn" :disabled="!date" @click="chooseDate">Posponer</button>
      </span>
      <p class="aa__note">Vuelve sola cuando cambie algo en la tarea: un commit, un review o el CI.</p>
    </div>
  </div>
</template>

<style scoped>
.aa { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; }
.aa__menu { display: flex; flex-wrap: wrap; gap: 0.4rem; flex: 1 1 100%; padding: 0.5rem; border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel-alt); }
.aa__opt { flex: 1 1 auto; }
.aa__date { display: flex; flex: 1 1 100%; gap: 0.4rem; }
.aa__date input { flex: 1; min-height: var(--tap-h); }
.aa__note { flex: 1 1 100%; margin: 0; color: var(--fg-dim); font-size: var(--fs-chrome); }
</style>
