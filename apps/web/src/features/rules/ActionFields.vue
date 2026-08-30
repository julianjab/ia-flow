<script setup lang="ts">
import { computed } from 'vue'
import { actionFormFor } from '@/features/rules/actionForms/registry'
import type { ActionEntry } from '@/features/rules/actionForms/types'

// Los campos propios de UNA acción, según su tipo.
//
// Es sólo el despacho: qué form corresponde lo decide el registry, y cada tipo
// tiene el suyo en `actionForms/`. Es el corte que hace que agregar un tipo de
// acción no toque este archivo ni el contenedor (`ActionsEditor`), que se ocupa
// del orden, el alta y la baja — que son iguales para todos los tipos.
//
// Mismo patrón que `providerForms` con el `providerConfig` de un agente.

const props = defineProps<{
  entry: ActionEntry
  agentIds?: string[]
  actionIds?: string[]
}>()

const emit = defineEmits<{
  (e: 'patch', changes: Record<string, unknown>): void
}>()

const form = computed(() => actionFormFor(props.entry.action))
</script>

<template>
  <component
    :is="form"
    :entry="entry"
    :agent-ids="agentIds"
    :action-ids="actionIds"
    @patch="(changes: Record<string, unknown>) => emit('patch', changes)"
  />
</template>
