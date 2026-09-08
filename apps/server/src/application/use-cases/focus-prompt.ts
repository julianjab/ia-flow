import { FOCUS_MAX_CLUSTERS, FOCUS_MAX_PICKS, FOCUS_WHY_MAX } from '@ia-flow/shared'

/**
 * El prompt del foco vive en código, no en la tabla de system prompts.
 *
 * Es la otra mitad del contrato de `GET /api/tasks/focus` —el formato de
 * salida que el endpoint promete— y ya se pagó una vez la lección con el
 * `focus` de `fs_read`: sembrar la fila desde una migración deja la feature
 * apagada en silencio en cualquier deploy que no la corrió, y encima pisa lo
 * que el operador editó. Mismo criterio que `packages/tools/src/fs/focus-prompt.ts`.
 */
export const FOCUS_SYSTEM_PROMPT = [
  'Sos un asistente que ayuda a un desarrollador a decidir por dónde empezar.',
  '',
  'Recibís las tareas que YA están ordenadas por urgencia mecánica: quién tiene',
  'que mover la próxima pieza, cuántas otras tareas traba cada una, y hace',
  'cuánto espera. Ese orden ya está resuelto y no es tu trabajo rehacerlo.',
  '',
  'Tu trabajo es el que ese orden no puede hacer: leer de QUÉ se tratan y',
  'nombrar lo que se repite. Que tres fallan por la misma causa. Que una traba',
  'a las otras y desbloquearla mueve todo. Que una se cierra en una sesión',
  'corta y otra no.',
  '',
  'Reglas:',
  `- Elegí como mucho ${FOCUS_MAX_PICKS} tareas, en el orden en que las empezarías.`,
  '- Usá SIEMPRE un `taskId` de la lista que recibiste, textual. No inventes ids.',
  `- El \`why\` dice por qué ÉSTA y no otra, en menos de ${FOCUS_WHY_MAX} caracteres.`,
  '  Nada de repetir lo que ya dice su razón: eso el usuario ya lo tiene en la fila.',
  '- `effort`: `quick` sólo si se cierra en una sesión corta; ante la duda, `deep`.',
  `- Los clusters agrupan tareas que comparten UNA causa concreta. Como mucho ${FOCUS_MAX_CLUSTERS},`,
  '  y ninguno con menos de dos tareas. Si no hay nada que agrupar, no agrupes.',
  '- El `headline` es una línea: lo más importante de todo el conjunto.',
  '  Si hay un solo cuello de botella, nombralo. Si no lo hay, decilo también.',
  '- No afirmes nada que no salga de los datos que recibiste. Si no sabés por qué',
  '  falla algo, decí lo que sí sabés.',
].join('\n')

export const FOCUS_TOOL_NAME = 'report_focus'
export const FOCUS_TOOL_DESCRIPTION =
  'Reportá por dónde empezar. Llamá esta tool exactamente una vez.'

/** El JSON Schema de la respuesta. Refleja `TaskFocusSchema` menos `computedAt`,
 *  que lo pone el server: la hora del cómputo no se la preguntamos al modelo. */
export const FOCUS_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    headline: {
      type: 'string',
      description: 'Una línea con lo más importante del conjunto.',
    },
    picks: {
      type: 'array',
      maxItems: FOCUS_MAX_PICKS,
      items: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'Un id textual de la lista recibida.' },
          why: {
            type: 'string',
            description: `Por qué ésta. Menos de ${FOCUS_WHY_MAX} caracteres.`,
          },
          effort: { type: 'string', enum: ['quick', 'deep'] },
        },
        required: ['taskId', 'why', 'effort'],
      },
    },
    clusters: {
      type: 'array',
      maxItems: FOCUS_MAX_CLUSTERS,
      items: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'La causa compartida, en pocas palabras.' },
          taskIds: { type: 'array', items: { type: 'string' }, minItems: 2 },
        },
        required: ['label', 'taskIds'],
      },
    },
  },
  required: ['headline', 'picks'],
} as const
