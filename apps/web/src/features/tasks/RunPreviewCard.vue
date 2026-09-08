<script setup lang="ts">
import type { TaskRunPreview } from '@ia-flow/shared';
import { computed, ref, watch } from 'vue';
import { extractErrorMessage } from '@/composables/extractErrorMessage';
import { fetchTaskRunPreview } from '@/features/tasks/api';
import { setProjectItemField } from '@/features/projects/sourceApi';
import { useToastStore } from '@/stores/toast';

/**
 * "¿Por qué esta tarea está siendo ignorada?"
 *
 * Reemplaza al timeline cuando la tarea nunca corrió: no hay pasos que mostrar,
 * y lo que hace falta es lo contrario — qué regla NO la tomó y qué le falta
 * para que la tome. Hasta ahora la única huella de eso era una línea
 * `Rules NOT matched` en el `daemon.log`.
 */
const props = defineProps<{
  projectId: string | null;
  taskId: string | null;
  /** Cambia después de un "Correr ahora": el veredicto puede haber cambiado. */
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

/** Ninguna regla la toma: es el caso que esta card existe para explicar. */
const ignored = computed(() => preview.value !== null && preview.value.matched.length === 0);

/** Cuántas reglas llegaron a evaluarse de verdad contra esta tarea. */
const evaluated = computed(() =>
  preview.value ? preview.value.matched.length + preview.value.rejected.length : 0,
);

const REASON_LABEL: Record<string, string> = {
  when: 'when',
  disabled: 'apagada',
  exclusive: 'exclusive',
  whenText: 'whenText',
};

/**
 * Qué habría que hacer para que ALGUNA regla la tome, derivado de las
 * condiciones que fallaron — no un texto fijo.
 *
 * Se mira sólo el `=`: una condición `!=` dice qué NO puede ser, y de eso no
 * sale una acción concreta. Sin nada derivable no se dibuja nada: una
 * sugerencia inventada es peor que ninguna.
 *
 * **Las de status son botones, no texto.** Eran una línea `→ mover a \`refine\`
 * o mover a \`build\`…` que no hacía nada: en esta app un `→` es un destino
 * (O2), y uno que no lleva a ningún lado enseña a no tocar los que sí. Mover
 * la tarea es un PATCH que la app ya sabe hacer, así que la sugerencia ES la
 * acción.
 */
const statusMoves = computed<string[]>(() => {
  const out: string[] = [];
  for (const rule of preview.value?.rejected ?? []) {
    for (const c of rule.failed ?? []) {
      if (c.op !== '=' || !c.value) continue;
      const field = c.field.toLowerCase();
      if (field === 'status' || field === 'to') out.push(c.value);
    }
  }
  return [...new Set(out)].slice(0, 3);
});

/** Las de label se quedan en texto: no hay un PATCH de labels, y un botón que
 *  no puede cumplir es el problema que esto vino a arreglar. */
const labelHint = computed<string | null>(() => {
  const wants: string[] = [];
  for (const rule of preview.value?.rejected ?? []) {
    for (const c of rule.failed ?? []) {
      if (c.op !== '=' || !c.value) continue;
      if (c.field.toLowerCase().includes('label')) wants.push(`\`${c.value}\``);
    }
  }
  const unique = [...new Set(wants)];
  return unique.length ? `También la tomaría con la label ${unique.slice(0, 3).join(' o ')}` : null;
});

const moving = ref<string | null>(null);
const toast = useToastStore();
const emit = defineEmits<{ (e: 'moved', status: string): void }>();

async function moveTo(status: string): Promise<void> {
  const pid = props.projectId;
  const tid = props.taskId;
  if (!pid || !tid || moving.value) return;
  moving.value = status;
  try {
    await setProjectItemField(pid, tid, 'status', status);
    toast.success(`Movida a ${status}`);
    // El veredicto que esta card muestra acaba de cambiar: se re-pregunta.
    await load();
    emit('moved', status);
  } catch (e) {
    toast.error(extractErrorMessage(e));
  } finally {
    moving.value = null;
  }
}
</script>

<template>
  <p v-if="error" class="rpc-line is-dim">No se pudo evaluar por qué correría: {{ error }}</p>

  <template v-else-if="preview">
    <!-- Tarjeta de estado: el veredicto en una línea, con el conteo de lo que
         se evaluó al lado. `no aplican` son las reglas de otros proyectos o de
         otro tipo de evento: se cuentan, no se listan. -->
    <section v-if="ignored" class="rpc-state">
      <p class="rpc-verdict">
        <span class="rpc-glyph" aria-hidden="true">○</span>
        {{ preview.blockedReason ?? 'Nunca se ejecutó' }}
      </p>
      <p class="rpc-count">
        Ninguna regla matcheó su status <code>{{ preview.status }}</code> ·
        {{ evaluated }} evaluada(s)<template v-if="preview.notApplicable">
          · {{ preview.notApplicable }} no aplican</template>
      </p>
    </section>

    <p v-else class="rpc-line is-ok">
      La toma
      <template v-for="(r, i) in preview.matched" :key="r.id">
        <span v-if="i > 0">, </span><code class="rpc-rule">{{ r.name }}</code>
      </template>
      <template v-if="preview.blockedReason"> — {{ preview.blockedReason }}</template>
    </p>

    <template v-if="ignored && preview.rejected.length">
      <span class="uc-label">Por qué se está ignorando</span>

      <article v-for="rule in preview.rejected" :key="rule.id" class="rpc-card">
        <header class="rpc-card-head">
          <span class="rpc-name">{{ rule.name }}</span>
          <span class="rpc-reason">{{ REASON_LABEL[rule.reason] ?? rule.reason }}</span>
        </header>

        <!-- Una regla apagada no tiene condiciones que mostrar: lo que hace
             falta es DÓNDE se prende. Sin esa línea, "no se puede" es un
             callejón sin salida. -->
        <template v-if="rule.reason === 'disabled'">
          <p class="rpc-cond-empty">deshabilitada en este proyecto</p>
          <RouterLink class="rpc-move" to="/general/pipeline">→ Prenderla en Pipeline</RouterLink>
        </template>

        <template v-else-if="rule.failed?.length">
          <p v-for="(c, i) in rule.failed" :key="`${c.field}-${i}`" class="rpc-cond">
            <span class="rpc-field">{{ c.field }}</span>
            <span class="rpc-op">{{ c.op }}</span>
            <span class="rpc-expected">{{ c.value ?? '' }}</span>
            <span class="rpc-spacer"></span>
            <!-- El valor REAL de la tarea. Que el evento no traiga el campo es
                 un problema distinto de que traiga otro valor, y el error de
                 config más común: se lee distinto. -->
            <span v-if="c.actual === null" class="rpc-missing">sin valor</span>
            <span v-else class="rpc-actual">{{ c.actual }}</span>
          </p>
        </template>

        <p v-else class="rpc-cond-empty">descartada por {{ rule.reason }}</p>
      </article>

      <!-- La sugerencia ES la acción: un botón por status que la destrabaría. -->
      <div v-if="statusMoves.length" class="rpc-moves">
        <button
          v-for="st in statusMoves"
          :key="st"
          type="button"
          class="rpc-move"
          :disabled="!!moving"
          :data-testid="`run-preview-move-${st}`"
          @click="moveTo(st)"
        >→ {{ moving === st ? `Moviendo a ${st}…` : `mover a ${st}` }}</button>
      </div>
      <p v-if="labelHint" class="rpc-cond-empty">{{ labelHint }}</p>
    </template>
  </template>
</template>

<style scoped>
.rpc-line {
  margin: 0;
  min-width: 0;
  font-size: var(--fs-micro);
  color: var(--fg-dim);
  overflow-wrap: anywhere;
}
.rpc-line.is-ok { color: var(--fg-dim); }
.rpc-line.is-dim { color: var(--fg-dimmer); }
.rpc-rule { font-family: var(--font-mono); color: var(--fg); }

/* La sugerencia hecha botón. `--tap-h` de área porque se toca (R1), y sin caja
   propia: es un verbo de fila, como el `→ Reintentar` de la lista. */
.rpc-moves { display: flex; flex-wrap: wrap; gap: 0.9rem; }
.rpc-move {
  display: inline-flex;
  align-items: center;
  min-height: var(--tap-h);
  padding: 0;
  border: none;
  background: none;
  color: var(--accent);
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  text-decoration: none;
  cursor: pointer;
}
.rpc-move:hover:not(:disabled) { background: transparent; text-decoration: underline; }
.rpc-move:disabled { color: var(--fg-dim); cursor: progress; }

.rpc-state {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  padding: 0.55rem 0.7rem;
  border: 1px solid var(--border);
  border-left: 2px solid var(--warn);
  border-radius: var(--radius);
  background: var(--yellow-bg);
}
.rpc-verdict {
  margin: 0;
  font-size: var(--fs-body-sm);
  color: var(--warn);
  overflow-wrap: anywhere;
}
.rpc-glyph { margin-right: 0.35rem; }
.rpc-count {
  margin: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--fg-dim);
  overflow-wrap: anywhere;
}

/* Una card por regla descartada: la regla es la unidad de decisión del
   engine, así que es también la unidad de lectura de por qué no corrió. */
.rpc-card {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  padding: 0.55rem 0.7rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel);
  min-width: 0;
}
.rpc-card-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
  min-width: 0;
}
.rpc-name {
  min-width: 0;
  font-size: var(--fs-body-sm);
  color: var(--fg);
  overflow-wrap: anywhere;
}
.rpc-reason {
  flex: 0 0 auto;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--warn);
}

/* Una fila por condición que falló: campo · operador · esperado … real. El
   esperado y el real quedan en los extremos porque la comparación entre esos
   dos es toda la información de la fila. */
.rpc-cond {
  display: flex;
  align-items: baseline;
  gap: 0.35rem;
  margin: 0;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
}
.rpc-field { color: var(--fg); }
.rpc-op { color: var(--fg-dim); }
.rpc-expected { color: var(--info); overflow-wrap: anywhere; }
.rpc-spacer { flex: 1 1 auto; min-width: 0.5rem; }
.rpc-actual { color: var(--danger); text-align: right; overflow-wrap: anywhere; }
.rpc-missing { color: var(--fg-dimmer); }
.rpc-cond-empty { margin: 0; font-size: var(--fs-micro); color: var(--fg-dim); }
.rpc-action { margin: 0; font-size: var(--fs-micro); color: var(--info); overflow-wrap: anywhere; }
</style>
