<script setup lang="ts">
import type { ViewBlock } from '@ia-flow/shared';
import { computed } from 'vue';
import { z } from 'zod';
import { findTaskUiOperation } from '@/features/tasks/uiContract';

/**
 * El renderer de la primitiva `row-action` — los botones que el asistente
 * propone dentro de una fila.
 *
 * Revalida sus propios props con Zod aunque la API ya haya forzado el schema
 * y el server ya haya filtrado: `ViewBlock.props` es `unknown` por diseño (su
 * forma la define el contrato, no un tipo compartido), así que este es el
 * lugar donde deja de serlo. Un bloque mal formado no se dibuja y no rompe la
 * fila — la lista de tareas tiene que seguir siendo usable aunque el canal
 * generativo devuelva basura.
 */
const props = defineProps<{
  block: ViewBlock
  taskId: string
  busy: boolean
}>()

const emit = defineEmits<{
  run: [op: string]
}>()

const PropsSchema = z.object({
  op: z.string().min(1),
  label: z.string().min(1),
})

const parsed = computed(() => {
  const result = PropsSchema.safeParse(props.block.props)
  if (!result.success) return null
  // Una operación que este bundle no conoce no se dibuja: el contrato la
  // ofreció, así que no debería pasar, pero un botón que no hace nada al
  // apretarlo es peor que un botón ausente.
  const op = findTaskUiOperation(result.data.op)
  return op ? { op, label: result.data.label } : null
})
</script>

<template>
  <button
    v-if="parsed"
    type="button"
    class="btn btn--ghost row-action"
    :disabled="busy"
    :title="parsed.op.description"
    :data-testid="`row-action-${parsed.op.id}-${taskId}`"
    @click="emit('run', parsed.op.id)"
  >
    <span class="row-action-glyph" aria-hidden="true">▶</span>
    <span>{{ busy ? '…' : parsed.label }}</span>
  </button>
</template>

<style scoped>
.row-action {
  height: var(--tap-h);
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  font-size: var(--fs-micro);
}
.row-action-glyph { color: var(--accent); }
</style>
