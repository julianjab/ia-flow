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
    <div class="dialog" role="dialog" aria-modal="true">
      <div class="head">
        <h3>{{ title ?? 'Confirmar' }}</h3>
      </div>
      <div class="body">
        <p>{{ message }}</p>
      </div>
      <div class="foot">
        <button class="btn-cancel" @click="emit('cancel')">{{ cancelLabel ?? 'Cancelar' }}</button>
        <button
          :class="['btn-confirm', danger ? 'danger' : '']"
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
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 300;
  padding: 1rem;
}
.dialog {
  background: var(--panel);
  border-radius: 12px;
  width: min(420px, 100%);
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.22);
  display: flex;
  flex-direction: column;
}
.head {
  padding: 1rem 1.25rem 0.5rem;
  border-bottom: 1px solid var(--panel-hi);
}
.head h3 { margin: 0; font-size: 1rem; color: #111; }
.body {
  padding: 1rem 1.25rem;
}
.body p { margin: 0; font-size: 0.9rem; color: var(--fg-mute); line-height: 1.5; }
.foot {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  padding: 0.75rem 1.25rem 1rem;
  border-top: 1px solid var(--panel-hi);
}
.btn-cancel {
  background: var(--panel);
  border: 1px solid var(--border-hi);
  color: var(--fg-mute);
  padding: 0.4rem 0.9rem;
  border-radius: 6px;
  font-size: 0.85rem;
  cursor: pointer;
}
.btn-cancel:hover { background: var(--panel-alt); }
.btn-confirm {
  background: var(--accent);
  border: 1px solid var(--accent);
  color: var(--panel);
  padding: 0.4rem 0.9rem;
  border-radius: 6px;
  font-size: 0.85rem;
  cursor: pointer;
}
.btn-confirm:hover { background: var(--accent); }
.btn-confirm.danger {
  background: var(--danger);
  border-color: var(--danger);
}
.btn-confirm.danger:hover { background: var(--danger); }
</style>
