<script setup lang="ts">
import { useInboxStore } from '@/features/inbox/store';

// El buscador de la bandeja (como el del menubar): un número, `repo#12`, `owner/repo#12`, el link
// de un issue o PR, o texto del título. Mientras tiene algo, la bandeja muestra los resultados
// (`SearchResults.vue`); Escape lo vacía.

const store = useInboxStore();
</script>

<template>
  <div class="is" role="search">
    <input
      :value="store.searchQuery"
      type="search"
      class="is__input"
      placeholder="Buscar: #4281, seller#12, un link o el título"
      aria-label="Buscar en la bandeja y el board"
      enterkeyhint="search"
      autocomplete="off"
      @input="store.setSearchQuery(($event.target as HTMLInputElement).value)"
      @keydown.esc="store.setSearchQuery('')"
    />
  </div>
</template>

<style scoped>
.is { display: flex; min-width: 0; }
.is__input {
  box-sizing: border-box;
  flex: 1;
  min-width: 0;
  min-height: var(--tap-h);
  padding: 0 0.75rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel);
  color: var(--fg);
  font: inherit;
  font-size: var(--fs-input);
}
.is__input::placeholder { color: var(--fg-dim); }
.is__input:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; border-color: var(--accent); }
@media (min-width: 768px) {
  .is__input { font-size: var(--fs-body); }
}
</style>
