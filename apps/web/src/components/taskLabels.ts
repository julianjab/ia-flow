import type { InboxGroup, InboxKind } from '@ia-flow/shared'

// Cómo se nombra cada grupo y cada caso de la bandeja. Lo usan la bandeja y las
// tareas que muestra el asistente: por eso vive acá y no en `features/inbox/`.

export const GROUP_LABEL: Record<InboxGroup, string> = {
  need: 'Te necesita',
  fail: 'Falló',
  run: 'Corriendo',
  queue: 'En cola',
  idle: 'Sin pendientes',
}

export const KIND_LABEL: Record<InboxKind, string> = {
  merge: 'Listo para mergear',
  prd: 'PRD para aprobar',
  doubt: 'El agente tiene una duda',
  stale: 'Sin movimiento',
  crash: 'Error del runner',
  ci: 'Esperando CI',
  agent: 'Agente trabajando',
  turn: 'Esperando turno',
  dep: 'Esperando otro issue',
  idle: 'Sin pendientes',
}
