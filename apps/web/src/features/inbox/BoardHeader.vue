<script setup lang="ts">
import { useIsMobile } from '@/composables/useIsMobile';
import InboxToolbar from '@/features/inbox/InboxToolbar.vue';
import { useInboxStore } from '@/features/inbox/store';

// El encabezado de las tres vistas de la bandeja (Para mí, En curso, Próximo): el nombre de la vista
// —el runner ya lo dice la barra de arriba (R9)—, una línea de qué hay, y el filtro de proyecto con
// los links al board. Lo de cada vista (el buscador, el orden) va en el slot.

defineProps<{ title: string; sub?: string }>();
const store = useInboxStore();
const { isMobile } = useIsMobile();
</script>

<template>
  <header class="bh">
    <div class="bh__title-row">
      <h1 class="bh__title">{{ title }}</h1>
      <span v-if="sub" class="bh__sub">{{ sub }}</span>
    </div>
    <InboxToolbar
      :projects="store.projects"
      :project="store.project"
      :stream="store.streamState"
      :loading="store.loading"
      :compact="isMobile"
      @project="store.project = $event"
      @refresh="store.refresh()"
    />
    <slot />
  </header>
</template>

<style scoped>
.bh { display: flex; flex-direction: column; gap: 0.6rem; min-width: 0; }
.bh__title-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.25rem 0.6rem; }
.bh__title { margin: 0; font-size: var(--fs-display); letter-spacing: -0.01em; }
.bh__sub { color: var(--fg-mute); }
</style>
