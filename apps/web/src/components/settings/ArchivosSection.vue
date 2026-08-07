<script setup lang="ts">
import { computed } from 'vue';
import { useProvidersStore } from '../../stores/providers';

const providersStore = useProvidersStore();
const providers = computed(() => providersStore.providers);
const githubProjectUrl = computed(() => providersStore.githubProjectUrl);
</script>

<template>
  <section class="about-section">
    <div class="about-grid">
      <div class="about-block">
        <h3>Archivos de configuración</h3>
        <ul class="about-list">
          <li>
            <code>apps/server/config/project-config.yaml</code>
            <span>Agentes reutilizables, statuses del flujo, registry de repos</span>
          </li>
          <li>
            <code>apps/server/config/providers.json</code>
            <span>Provider global, modelo, system prompt, repo mappings GitHub</span>
          </li>
          <li>
            <code>apps/server/config/prompts/</code>
            <span>Archivos de prompt referenciados desde project-config.yaml</span>
          </li>
          <li>
            <code>tasks/</code>
            <span>Cola de tareas en YAML — un dir por status</span>
          </li>
        </ul>
      </div>

      <div class="about-block">
        <h3>Variables de entorno</h3>
        <ul class="about-list">
          <li>
            <code>ANTHROPIC_API_KEY</code>
            <span>Requerida para el proveedor anthropic-api</span>
          </li>
          <li>
            <code>CLAUDE_CODE_OAUTH_TOKEN</code>
            <span>Alternativa OAuth al API key</span>
          </li>
          <li>
            <code>GITHUB_TOKEN</code>
            <span>Para crear issues y PRs en GitHub Projects</span>
          </li>
          <li>
            <code>GITHUB_PROJECT_URL</code>
            <span>URL del GitHub Project board que usa el daemon</span>
            <a v-if="githubProjectUrl" :href="githubProjectUrl" target="_blank" rel="noopener" class="env-link">Abrir proyecto →</a>
            <span v-else class="env-missing">No configurada — daemon GitHub deshabilitado</span>
          </li>
        </ul>
      </div>

      <div class="about-block">
        <h3>Providers disponibles</h3>
        <ul class="about-list">
          <li v-for="p in providers" :key="p.id">
            <code>{{ p.id }}</code>
            <span>{{ p.description }}</span>
          </li>
        </ul>
      </div>

      <div class="about-block">
        <h3>Flujo de estados de una tarea</h3>
        <div class="state-flow">
          <span class="state-chip state-queued">queued</span>
          <span class="state-arrow">→</span>
          <span class="state-chip state-refining">refining</span>
          <span class="state-arrow">→</span>
          <span class="state-chip state-refined">refined</span>
          <span class="state-arrow">→ (aprobar)</span>
          <span class="state-chip state-approved">approved</span>
        </div>
        <p class="about-note">
          El daemon observa <code>tasks/</code> y ejecuta el agente configurado para cada status.
          Los statuses son dinámicos — cualquier valor en <code>project-config.yaml</code> crea su
          propio directorio automáticamente.
        </p>
      </div>
    </div>

    <div class="about-footer">
      <span>ia-flow v1.0.0</span>
      <span class="about-sep">·</span>
      <a href="https://github.com/anthropics/claude-code" target="_blank" rel="noopener">Claude Code docs</a>
      <span class="about-sep">·</span>
      <a href="https://console.anthropic.com" target="_blank" rel="noopener">Anthropic Console</a>
    </div>
  </section>
</template>

<style scoped>
.about-section { border: 1px solid #e5e7eb; border-radius: 10px; overflow: hidden; }
.about-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0; }
.about-block { padding: 1rem 1.1rem; border-bottom: 1px solid #f3f4f6; }
.about-block:nth-child(odd) { border-right: 1px solid #f3f4f6; }
.about-block h3 {
  margin: 0 0 0.6rem;
  font-size: 0.82rem;
  font-weight: 600;
  color: #374151;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.about-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
.about-list li { display: flex; flex-direction: column; gap: 0.1rem; }
.about-list code {
  font-size: 0.78rem;
  background: #f3f4f6;
  padding: 0.1rem 0.35rem;
  border-radius: 3px;
  color: #1e293b;
  font-family: 'SF Mono', 'Fira Code', monospace;
  width: fit-content;
}
.about-list span { font-size: 0.75rem; color: #6b7280; }

.state-flow { display: flex; align-items: center; flex-wrap: wrap; gap: 0.3rem; margin-bottom: 0.6rem; }
.state-chip { font-size: 0.72rem; padding: 0.15rem 0.5rem; border-radius: 4px; font-weight: 500; }
.state-arrow { font-size: 0.75rem; color: #9ca3af; }
.state-queued   { background: #f3f4f6; color: #374151; }
.state-refining { background: #fef3c7; color: #92400e; }
.state-refined  { background: #dbeafe; color: #1e40af; }
.state-approved { background: #d1fae5; color: #065f46; }
.about-note { margin: 0; font-size: 0.75rem; color: #6b7280; line-height: 1.5; }

.about-footer {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.65rem 1.1rem;
  background: #f9fafb;
  font-size: 0.78rem;
  color: #9ca3af;
}
.about-sep { color: #d1d5db; }
.about-footer a { color: #6b7280; text-decoration: none; }
.about-footer a:hover { color: #2563eb; text-decoration: underline; }
.env-link { font-size: 0.75rem; color: #2563eb; text-decoration: none; width: fit-content; }
.env-link:hover { text-decoration: underline; }
.env-missing { font-size: 0.73rem; color: #f59e0b; }
</style>
