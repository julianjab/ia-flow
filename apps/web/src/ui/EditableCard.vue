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
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  background: #fff;
  transition: border-color 0.15s, background 0.15s, box-shadow 0.15s;
}

.editable-card--clickable {
  cursor: pointer;
}
.editable-card--clickable:hover {
  border-color: #2563eb;
  background: #f8faff;
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
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: #fff;
  font-size: 0.8rem;
  color: #374151;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.1s, border-color 0.1s;
}
.ec-btn-edit:hover {
  background: #f3f4f6;
  border-color: #9ca3af;
}

.ec-btn-delete {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  border: 1px solid #fca5a5;
  border-radius: 6px;
  background: #fff;
  color: #ef4444;
  font-size: 0.8rem;
  cursor: pointer;
  transition: background 0.1s, border-color 0.1s;
}
.ec-btn-delete:hover {
  background: #fef2f2;
  border-color: #ef4444;
}
</style>
