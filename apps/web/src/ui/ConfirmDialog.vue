<script setup lang="ts">
defineProps<{
  open: boolean;
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}>();

const emit = defineEmits<{
  confirm: [];
  cancel: [];
}>();
</script>

<template>
  <div v-if="open" class="overlay" @click.self="emit('cancel')">
    <div class="dialog" role="dialog" aria-modal="true" :aria-label="title ?? 'Confirmar'">
      <div class="head">
        <h3>{{ title ?? 'Confirmar' }}</h3>
      </div>
      <div class="body">
        <p>{{ message }}</p>
      </div>
      <div class="foot">
        <button type="button" class="btn" @click="emit('cancel')">{{ cancelLabel ?? 'Cancelar' }}</button>
        <button
          type="button"
          :class="['btn', danger ? 'btn--destructive' : 'btn--primary']"
          @click="emit('confirm')"
        >{{ confirmLabel ?? 'Confirmar' }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 300;
  padding: 1rem;
}
.dialog {
  background: var(--panel);
  border: 1px solid var(--border-hi);
  border-radius: var(--radius);
  width: min(26rem, 100%);
  display: flex;
  flex-direction: column;
}
.head { padding: 0.75rem 1rem 0.5rem; border-bottom: 1px solid var(--border); }
.head h3 { margin: 0; font-size: var(--fs-body); text-transform: uppercase; letter-spacing: var(--tracking-hd); }
.body { padding: 0.75rem 1rem; }
.body p { margin: 0; font-size: var(--fs-body-sm); color: var(--fg-mute); line-height: 1.5; }
.foot { display: flex; justify-content: flex-end; gap: 0.5rem; padding: 0.75rem 1rem; border-top: 1px solid var(--border); }
</style>
