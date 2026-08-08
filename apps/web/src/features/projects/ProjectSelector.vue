<script setup lang="ts">
import { computed } from 'vue'
import { useProjectsStore } from '@/features/projects/store'

const store = useProjectsStore()

const projects = computed(() => store.projects)
const activeId = computed({
  get: () => store.activeProjectId ?? '',
  set: (id: string) => store.setActiveProjectId(id || null),
})
</script>

<template>
  <label class="project-selector" v-if="projects.length">
    <span class="project-selector__label">Proyecto</span>
    <select v-model="activeId" class="project-selector__select" data-testid="project-selector">
      <option v-for="p in projects" :key="p.id" :value="p.id">
        {{ p.name }}
      </option>
    </select>
  </label>
</template>

<style scoped>
.project-selector {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.85rem;
}
.project-selector__label {
  color: #6b7280;
  font-weight: 500;
}
.project-selector__select {
  padding: 0.35rem 0.5rem;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: #fff;
  font-size: 0.9rem;
  min-width: 180px;
}
</style>
