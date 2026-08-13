<script setup lang="ts">
defineProps<{
  clickable?: boolean      // whole card triggers edit on click
  showEditButton?: boolean // explicit "Editar" button (default: !clickable)
  deleteLabel?: string
}>()

const emit = defineEmits<{
  edit: []
  delete: []
}>()

function handleCardClick() {
  // only fire when clickable=true; repo cards have explicit button
}
</script>

<template>
  <div
    class="editable-card"
    :class="{ 'editable-card--clickable': clickable }"
    @click="clickable ? emit('edit') : undefined"
  >
    <div class="editable-card__body">
      <slot />
    </div>

    <div class="editable-card__actions" @click.stop>
      <button
        v-if="showEditButton ?? !clickable"
        class="ec-btn-edit"
        @click="emit('edit')"
      >Editar</button>
      <button
        class="ec-btn-delete"
        :title="deleteLabel ?? 'Eliminar'"
        @click="emit('delete')"
      >✕</button>
    </div>
  </div>
</template>

<style scoped>
.editable-card {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
  transition: border-color 0.15s, background 0.15s, box-shadow 0.15s;
}

.editable-card--clickable {
  cursor: pointer;
}
.editable-card--clickable:hover {
  border-color: var(--accent);
  background: var(--panel-alt);
  box-shadow: 0 1px 4px rgba(37,99,235,0.08);
}

.editable-card__body {
  flex: 1;
  min-width: 0;
}

.editable-card__actions {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  flex-shrink: 0;
}

.ec-btn-edit {
  padding: 0.3rem 0.75rem;
  border: 1px solid var(--border-hi);
  border-radius: 6px;
  background: var(--panel);
  font-size: 0.8rem;
  color: var(--fg-mute);
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.1s, border-color 0.1s;
}
.ec-btn-edit:hover {
  background: var(--panel-hi);
  border-color: var(--fg-dim);
}

.ec-btn-delete {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  border: 1px solid var(--danger);
  border-radius: 6px;
  background: var(--panel);
  color: var(--danger);
  font-size: 0.8rem;
  cursor: pointer;
  transition: background 0.1s, border-color 0.1s;
}
.ec-btn-delete:hover {
  background: var(--red-bg);
  border-color: var(--danger);
}
</style>
