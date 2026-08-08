<script setup lang="ts">
import { computed } from 'vue';
import { useProjectConfigStore } from '@/features/project-config/store';

// Kanban-style read view: one column per status of the active project. Each
// column lists the agents wired to run on that status. Task cards fetched
// from the project manager land here in a follow-up commit.
defineProps<{ projectId: string }>();

const configStore = useProjectConfigStore();

const statuses = computed(() => configStore.config?.statuses ?? []);
const agentsById = computed(() => {
  const map = new Map<string, string>();
  for (const a of configStore.config?.agents ?? []) map.set(a.id, a.provider);
  return map;
});
</script>

<template>
  <section class="pbt-section">
    <h2>Board</h2>
    <p class="pbt-desc">Columnas configuradas para este proyecto y los agentes que corren en cada una.</p>

    <div v-if="!statuses.length" class="pbt-empty">
      Aún no hay statuses configurados para este proyecto.
    </div>

    <div v-else class="pbt-columns">
      <article v-for="status in statuses" :key="status.name" class="pbt-column">
        <header class="pbt-column__header">
          <span class="pbt-column__name">{{ status.name }}</span>
          <span class="pbt-column__count">{{ status.agents.length }} agents</span>
        </header>

        <div v-if="!status.agents.length" class="pbt-column__empty">Sin agentes asignados</div>

        <ul v-else class="pbt-agent-list">
          <li v-for="(entry, i) in status.agents" :key="`${status.name}-${entry.agent}-${i}`" class="pbt-agent">
            <code class="pbt-agent__id">{{ entry.agent }}</code>
            <span v-if="agentsById.get(entry.agent)" class="pbt-agent__provider">
              {{ agentsById.get(entry.agent) }}
            </span>
            <span v-else class="pbt-agent__missing">⚠︎ no definido</span>
          </li>
        </ul>
      </article>
    </div>
  </section>
</template>

<style scoped>
.pbt-section {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  padding: 1.25rem;
}
.pbt-section h2 { margin: 0 0 0.5rem; font-size: 1.15rem; }
.pbt-desc { margin: 0 0 1rem; color: #6b7280; font-size: 0.9rem; }
.pbt-empty {
  padding: 1rem;
  color: #6b7280;
  background: #f9fafb;
  border-radius: 6px;
  text-align: center;
}
.pbt-columns {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 0.75rem;
}
.pbt-column {
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 0.75rem;
  min-height: 100px;
}
.pbt-column__header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}
.pbt-column__name { font-weight: 600; font-size: 0.95rem; }
.pbt-column__count { color: #6b7280; font-size: 0.75rem; }
.pbt-column__empty { font-size: 0.8rem; color: #9ca3af; font-style: italic; }
.pbt-agent-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.35rem; }
.pbt-agent {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  padding: 0.4rem 0.5rem;
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
  font-size: 0.85rem;
}
.pbt-agent__id { font-family: ui-monospace, SFMono-Regular, monospace; }
.pbt-agent__provider { color: #6b7280; font-size: 0.75rem; }
.pbt-agent__missing { color: #b91c1c; font-size: 0.75rem; }
</style>
