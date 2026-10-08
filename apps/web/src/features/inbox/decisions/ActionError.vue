<script setup lang="ts">
import type { ActionFailure } from '@/features/inbox/queue/advice';

// El error de una acción, pegado al botón que falló: «✕ qué pasó» y «→ qué hacer», con
// «Reintentar» a mano.

defineProps<{ failure: ActionFailure; busy?: boolean }>();
const emit = defineEmits<{ (e: 'retry'): void }>();
</script>

<template>
  <div class="ae" role="alert" data-test="action-error">
    <p class="ae__what">✕ {{ failure.what }}</p>
    <p class="ae__next">→ {{ failure.next }}</p>
    <button type="button" class="btn btn--ghost ae__retry" :disabled="busy" @click="emit('retry')">Reintentar</button>
  </div>
</template>

<style scoped>
.ae {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.15rem 0.8rem;
  padding: 0.35rem 0.4rem 0.35rem 0.75rem;
  border-radius: var(--radius);
  background: var(--red-bg);
  font-size: var(--fs-body-sm);
  line-height: 1.45;
}
.ae p { margin: 0; overflow-wrap: anywhere; }
.ae__what { flex: 1 1 100%; color: var(--danger); }
.ae__next { flex: 1 1 12rem; color: var(--info); }
.ae__retry { margin-left: auto; color: var(--fg); }
</style>
