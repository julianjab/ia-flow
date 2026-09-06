<script setup lang="ts">
import type { TaskRunPreview } from '@ia-flow/shared';
import { computed, ref, watch } from 'vue';
import { extractErrorMessage } from '@/composables/extractErrorMessage';
import { fetchTaskRunPreview } from '@/features/tasks/api';

const props = defineProps<{
  projectId: string | null;
  taskId: string | null;
  /** Cambia después de un "Correr ahora": el veredicto puede haber cambiado
   *  (ahora hay un run en curso). */
  reloadToken?: unknown;
}>();

const preview = ref<TaskRunPreview | null>(null);
const error = ref<string | null>(null);

async function load() {
  if (!props.projectId || !props.taskId) return;
  const taskId = props.taskId;
  error.value = null;
  try {
    const data = await fetchTaskRunPreview(props.projectId, taskId);
    if (props.taskId === taskId) preview.value = data;
  } catch (e) {
    if (props.taskId === taskId) {
      preview.value = null;
      error.value = extractErrorMessage(e);
    }
  }
}

watch(() => [props.taskId, props.reloadToken], load, { immediate: true });

/** Ninguna regla la toma: es el caso que el operador necesita ver ANTES de
 *  apretar, porque el botón va a "no hacer nada" y eso no se distingue de un
 *  fallo. */
const willNotRun = computed(() => preview.value !== null && preview.value.matched.length === 0);
</script>

<template>
  <p v-if="error" class="preview-line is-dim">No se pudo evaluar por qué correría: {{ error }}</p>

  <template v-else-if="preview">
    <p v-if="preview.blockedReason" class="preview-line is-warn">{{ preview.blockedReason }}</p>

    <p v-if="preview.matched.length" class="preview-line is-ok">
      La toma
      <template v-for="(r, i) in preview.matched" :key="r.id">
        <span v-if="i > 0">, </span><code class="preview-rule">{{ r.name }}</code>
      </template>
    </p>

    <template v-else>
      <p class="preview-line is-warn">
        Ninguna regla matchea el status <code class="preview-rule">{{ preview.status }}</code
        >: apretar “Correr ahora” no va a levantar ningún agente.
      </p>
      <ul v-if="preview.rejected.length" class="preview-rejects">
        <li v-for="r in preview.rejected" :key="r.id" class="preview-reject">
          <code class="preview-rule">{{ r.name }}</code>
          <span v-if="r.reason === 'disabled'"> está deshabilitada</span>
          <span v-else-if="r.reason === 'exclusive'"> quedó tapada por una regla exclusiva</span>
          <span v-else-if="r.failed?.length">
            no cumple:
            <template v-for="(c, i) in r.failed" :key="`${c.field}-${i}`">
              <span v-if="i > 0">, </span>
              <!-- El valor REAL al lado del esperado: `—` (el campo no vino en
                   el evento) es un problema distinto de "vino otro valor", y
                   colapsarlos es lo que obliga a leer el daemon.log. -->
              {{ c.field }} {{ c.op }} {{ c.value ?? '' }} (es {{ c.actual ?? '—' }})
            </template>
          </span>
          <span v-else> descartada por {{ r.reason }}</span>
        </li>
      </ul>
      <p v-if="preview.notApplicable" class="preview-line is-dim">
        + {{ preview.notApplicable }} regla(s) que no aplican a esta tarea (otro proyecto u otro
        tipo de evento).
      </p>
    </template>
  </template>
</template>

<style scoped>
.preview-line {
  margin: 0;
  font-size: var(--fs-micro);
  color: var(--fg-dim);
}
.preview-line.is-ok { color: var(--fg-dim); }
.preview-line.is-warn { color: var(--warn, #b7791f); }
.preview-line.is-dim { color: var(--fg-dimmer); }
.preview-rule { font-family: var(--font-mono); color: var(--fg); }
.preview-rejects {
  list-style: none;
  margin: 0;
  padding: 0 0 0 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}
.preview-reject { font-size: var(--fs-micro); color: var(--fg-dim); }
</style>
