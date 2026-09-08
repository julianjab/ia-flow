<script setup lang="ts">
import { computed } from 'vue';
import { useActiveExecutionsStore } from '@/features/executions/activeStore';
import { useRateLimitStore } from '@/features/github/store';
import ProjectPollingToggle from '@/features/projects/ProjectPollingToggle.vue';
import BottomSheet from '@/ui/BottomSheet.vue';

/**
 * El sheet de `⋯` — lo que la barra de identidad ya no dibuja.
 *
 * La barra mide `--tap-h` y en ese ancho entran cinco cosas: volver, el
 * proyecto, dónde estás, si algo corre, y esto. El rate limit de GitHub y el
 * detalle de lo que está corriendo no son identidad: son estado del server que
 * se consulta cuando algo va mal, no en cada pantalla. Con los dos chips
 * dibujados, el chrome de 390px medía 200px de alto (R12).
 *
 * El punto vivo de la barra sigue diciendo lo único que hay que saber sin
 * abrir nada: si hay algo corriendo o no. El número está acá.
 */
defineProps<{
  open: boolean;
  serverLabel: string;
  /** El proyecto abierto, si hay uno. Es lo que decide si el sheet ofrece
   *  pausar su polling — el control que vivía en el `.pd-header` borrado. */
  projectId?: string | null;
}>();
const emit = defineEmits<{ close: []; 'go-servers': [] }>();

const activeExecutions = useActiveExecutionsStore();
const rateLimit = useRateLimitStore();

/**
 * El rate limit, dicho como una línea.
 *
 * `null` cuando el server todavía no contestó: un "no sé" dibujado como
 * "0 de 0" es peor que el silencio (DESIGN_SYSTEM · Ausencia).
 */
const rateLimitLine = computed<string | null>(() => {
  const s = rateLimit.snapshot;
  if (!s || s.remaining === null || s.limit === null) return null;
  return `${s.remaining} / ${s.limit}`;
});

const rateLimitState = computed<'ok' | 'low' | 'limited'>(() => {
  const s = rateLimit.snapshot;
  if (s?.limited) return 'limited';
  if (s && s.remaining !== null && s.limit) {
    if (s.remaining / s.limit <= 0.1) return 'low';
  }
  return 'ok';
});
</script>

<template>
  <BottomSheet :open="open" title="Este server" @close="emit('close')">
    <dl class="cms">
      <div class="cms__row">
        <dt class="uc-label">Corriendo</dt>
        <dd class="cms__val">
          <template v-if="activeExecutions.loaded">
            <span
              class="cms__glyph"
              :class="{ 'cms__glyph--live': activeExecutions.activeCount > 0 }"
              aria-hidden="true"
            >{{ activeExecutions.activeCount > 0 ? '●' : '○' }}</span>
            {{ activeExecutions.activeCount }}
            {{ activeExecutions.activeCount === 1 ? 'ejecución' : 'ejecuciones' }}
          </template>
          <span v-else class="cms__unknown">sin consultar</span>
        </dd>
      </div>

      <div class="cms__row">
        <dt class="uc-label">GitHub API</dt>
        <dd class="cms__val" :class="`cms__val--${rateLimitState}`">
          <template v-if="rateLimitLine">{{ rateLimitLine }} restantes</template>
          <span v-else class="cms__unknown">sin consultar</span>
        </dd>
      </div>

      <div class="cms__row">
        <dt class="uc-label">Server</dt>
        <dd class="cms__val mono">{{ serverLabel }}</dd>
      </div>
    </dl>

    <!-- La pausa de polling es del PROYECTO, no del server, y por eso va
         debajo y separada: es la única acción de este sheet que cambia algo. -->
    <ProjectPollingToggle v-if="projectId" :key="projectId" :project-id="projectId" />

    <button type="button" class="cms__action" @click="emit('go-servers')">
      ⇄ Cambiar de server
    </button>
  </BottomSheet>
</template>

<style scoped>
.cms { margin: 0; padding: 0; }
.cms__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  min-height: var(--tap-h);
  padding: 0 1rem;
  border-bottom: 1px solid var(--border-mute);
}
.cms__val {
  margin: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-body-sm);
  color: var(--fg);
  text-align: right;
}
.cms__val--low { color: var(--warn); }
.cms__val--limited { color: var(--danger); }
.cms__unknown { color: var(--fg-dimmer); }
.cms__glyph { color: var(--fg-dimmer); }
.cms__glyph--live { color: var(--accent); }

.cms__action {
  width: 100%;
  height: var(--tap-h);
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0 1rem;
  border: none;
  background: none;
  color: var(--fg-mute);
  font-family: var(--font-mono);
  font-size: var(--fs-body-sm);
  text-align: left;
  cursor: pointer;
}
.cms__action:hover { background: var(--panel-hi); color: var(--fg); }
</style>
