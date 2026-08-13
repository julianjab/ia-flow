<script setup lang="ts">
import { useToastStore } from '@/stores/toast';

const store = useToastStore();
</script>

<template>
  <Teleport to="#toast-container">
    <div
      v-for="toast in store.toasts"
      :key="toast.id"
      class="toast"
      :class="`toast-${toast.variant}`"
      role="status"
      :data-variant="toast.variant"
      @click="store.dismiss(toast.id)"
    >
      {{ toast.message }}
    </div>
  </Teleport>
</template>

<style scoped>
.toast {
  padding: 0.6rem 0.9rem;
  border-radius: 6px;
  color: var(--panel);
  font-size: 0.9rem;
  cursor: pointer;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  min-width: 12rem;
}
.toast-success {
  background: var(--accent);
}
.toast-error {
  background: var(--danger);
}
</style>
