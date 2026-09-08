import { TASK_GROUPS_MAX_GROUPS } from '@ia-flow/shared'

/**
 * El prompt de los grupos vive en código, no en la tabla de system prompts.
 *
 * Mismo criterio que `focus-prompt.ts`: es la otra mitad del contrato de
 * `GET /api/tasks/groups` — el formato de salida que el endpoint promete.
 */
export const TASK_GROUPS_SYSTEM_PROMPT = [
  'Sos un asistente que ayuda a un desarrollador a barrer una lista larga de',
  'tareas pendientes sin perderse.',
  '',
  'Recibís las tareas que le esperan, ya ordenadas por urgencia mecánica: quién',
  'tiene que mover la próxima pieza, cuántas otras tareas traba cada una, y',
  'hace cuánto espera. Ese orden ya está resuelto y no es tu trabajo rehacerlo',
  'ni proponer uno nuevo — sólo decís qué tareas comparten tema.',
  '',
  'Reglas:',
  `- Agrupá tareas que comparten UNA causa o tema concreto: el mismo feature,`,
  '  el mismo bug, el mismo repo y frente de trabajo. No agrupes por casualidad',
  '  (dos tareas del mismo repo sin relación real no son un grupo).',
  '- Un grupo tiene como mínimo dos tareas. Si una tarea no comparte tema con',
  '  ninguna otra, dejala afuera de todo grupo — no inventes un grupo de una.',
  `- Como mucho ${TASK_GROUPS_MAX_GROUPS} grupos.`,
  '- `label`: el tema en pocas palabras, sin repetir el título completo de',
  '  ninguna tarea.',
  '- Usá SIEMPRE `taskId` de la lista que recibiste, textual. No inventes ids.',
  '- Una tarea va en UN SOLO grupo, el que mejor la describe.',
  '- No afirmes una relación que no salga de los títulos/razones que recibiste.',
].join('\n')

export const TASK_GROUPS_TOOL_NAME = 'report_task_groups'
export const TASK_GROUPS_TOOL_DESCRIPTION =
  'Reportá los grupos por tema. Llamá esta tool exactamente una vez.'

/** El JSON Schema de la respuesta. Refleja `TaskGroupsSchema` menos
 *  `computedAt`, que lo pone el server. */
export const TASK_GROUPS_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    groups: {
      type: 'array',
      maxItems: TASK_GROUPS_MAX_GROUPS,
      items: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'El tema compartido, en pocas palabras.' },
          taskIds: { type: 'array', items: { type: 'string' }, minItems: 2 },
        },
        required: ['label', 'taskIds'],
      },
    },
  },
  required: ['groups'],
} as const
