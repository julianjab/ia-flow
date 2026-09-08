<script setup lang="ts">
import { computed } from 'vue';
import { useActiveExecutionsStore } from '@/features/executions/activeStore';
import { useProjectsStore } from '@/features/projects/store';

/**
 * Cambiar de proyecto, en mobile.
 *
 * El drawer mezclaba dos preguntas distintas: *en qué proyecto estoy* y *a qué
 * pantalla voy*. Se separan: la tab bar es la pantalla, el header es el
 * proyecto, y este sheet es cómo se cambia.
 *
 * Cada fila trae el estado agregado del proyecto — es lo que permite ver dónde
 * hay fuego sin entrar.
 */
defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: []; pick: [projectId: string] }>();

const projectsStore = useProjectsStore();
const activeExecutions = useActiveExecutionsStore();

interface Row {
  id: string;
  name: string;
  running: number;
  current: boolean;
}

const rows = computed<Row[]>(() =>
  projectsStore.projects.map((p) => ({
    id: p.id,
    name: p.name ?? p.id,
    running: activeExecutions.countForProject(p.id),
    current: p.id === projectsStore.activeProjectId,
  })),
);

/**
 * Qué se dice de cada proyecto.
 *
 * Sólo lo que el shell YA sabe: los runs en vuelo. El conteo de tareas y los
 * "fallos sin atender" que pide el diseño necesitan una request por proyecto;
 * hasta que exista un agregado, decir `nada corriendo` es cierto y `7 tareas`
 * sería inventado.
 */
function meta(row: Row): string {
  if (!activeExecutions.loaded) return '';
  return row.running ? `${row.running} corriendo` : 'nada corriendo';
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="psheet-backdrop" @click.self="emit('close')">
      <div class="psheet" role="dialog" aria-modal="true" aria-label="Cambiar de proyecto">
        <div class="psheet__head">
          <span class="uc-label">Proyecto</span>
          <span class="psheet__count">{{ rows.length }} en este server</span>
        </div>

        <ul class="psheet__list">
          <li v-for="row in rows" :key="row.id">
            <button
              type="button"
              class="psheet__row"
              :class="{ 'is-current': row.current }"
              @click="emit('pick', row.id)"
            >
              <!-- El glifo dice el estado del proyecto sin entrar: vivo si algo
                   corre, apagado si no. El actual lleva el cursor de fila. -->
              <span v-if="row.current" class="psheet__glyph" aria-hidden="true">▸</span>
              <span v-else-if="row.running" class="live-dot psheet__glyph" aria-hidden="true"></span>
              <span v-else class="psheet__glyph is-idle" aria-hidden="true">○</span>
              <span class="psheet__text">
                <span class="psheet__name">{{ row.name }}</span>
                <span v-if="meta(row)" class="psheet__meta">{{ meta(row) }}</span>
              </span>
            </button>
          </li>
        </ul>

        <RouterLink class="psheet__server" to="/servers" @click="emit('close')">
          ⇄ Cambiar de server
        </RouterLink>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.psheet-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  z-index: 80;
  display: flex;
  align-items: flex-end;
}
/* Mismo bottom sheet que el resto: entra desde abajo en 150ms, el mismo timing
   que ya usa el drawer del sidebar. */
.psheet {
  width: 100%;
  max-height: 80vh;
  overflow-y: auto;
  background: var(--panel);
  border-top: 1px solid var(--border-hi);
  border-radius: 12px 12px 0 0;
  padding: 0.7rem 0 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
  animation: psheet-in 150ms ease;
}
@keyframes psheet-in {
  from { transform: translateY(100%); }
  to { transform: translateY(0); }
}
.psheet__head { display: flex; align-items: center; justify-content: space-between; padding: 0 1rem; }
.psheet__count { font-family: var(--font-mono); font-size: var(--fs-micro); color: var(--fg-dimmer); }

.psheet__list { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--border); }
.psheet__row {
  width: 100%;
  height: 52px;
  display: flex;
  align-items: center;
  gap: 0.55rem;
  padding: 0 1rem;
  background: var(--panel);
  border: none;
  border-bottom: 1px solid var(--border);
  color: var(--fg);
  text-align: left;
  cursor: pointer;
}
/* El proyecto actual en video inverso, como toda selección del sistema. */
.psheet__row.is-current { background: var(--accent); color: var(--panel); }
.psheet__glyph { flex: 0 0 auto; }
.psheet__glyph.is-idle { color: var(--fg-dimmer); }
.psheet__text { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.psheet__name {
  font-family: var(--font-mono);
  font-size: var(--fs-body-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.psheet__row.is-current .psheet__name { font-weight: 700; }
.psheet__meta { font-family: var(--font-mono); font-size: var(--fs-micro); color: var(--fg-dim); }
.psheet__row.is-current .psheet__meta { color: var(--panel); opacity: 0.75; }

.psheet__server {
  height: 48px;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0 1rem;
  color: var(--fg-mute);
  font-family: var(--font-mono);
  font-size: var(--fs-body-sm);
  text-decoration: none;
}
.psheet__server:hover { background: var(--panel-hi); color: var(--fg); }
</style>
