import type { InboxGroup, InboxKind, TaskAction } from '@ia-flow/shared'

// El vocabulario de la bandeja: qué dice cada grupo, cada caso y cada acción.
// Vive junto a la feature (no en `shared`): es copy de esta pantalla, el
// contrato sólo fija las claves. El nombre de cada grupo y cada caso lo comparte
// con el asistente, así que vive en `components/`.
export { GROUP_LABEL, KIND_LABEL } from '@/components/taskLabels'

/** Los cuatro grupos que dibuja la bandeja, en orden de urgencia. `idle` nunca sale de `/api/inbox`. */
export const GROUPS: readonly Exclude<InboxGroup, 'idle'>[] = ['need', 'fail', 'run', 'queue']

export const GROUP_HINT: Record<InboxGroup, string> = {
  need: 'el pipeline se detuvo y sólo vos lo movés',
  fail: 'se rompió algo, no es una decisión',
  run: 'nada que hacer',
  queue: 'va a correr, todavía no',
  idle: 'está en el board, no espera nada de nadie',
}

export const ACTION_LABEL: Record<TaskAction, string> = {
  merge: 'Mergear PR',
  approve_prd: 'Aprobar y pasar a Build',
  back_to_refine: 'Devolver a Refine',
  answer_and_unblock: 'Responder y destrabar',
  relaunch: 'Relanzar',
  retry: 'Reintentar',
  stop: 'Detener',
  rerun_review: 'Re-ejecutar review',
}

/** La pregunta de confirmación en la página (no `window.confirm`). */
export function confirmText(action: TaskAction, ref: string): string {
  switch (action) {
    case 'merge':
      return `¿Mergear el PR de ${ref}? Queda firmado con tu usuario de GitHub.`
    case 'approve_prd':
      return `¿Aprobar el PRD de ${ref} y pasarla a Build?`
    case 'back_to_refine':
      return `¿Devolver ${ref} a Refine?`
    case 'answer_and_unblock':
      return `¿Publicar tu respuesta en ${ref} y quitarle blocked?`
    case 'relaunch':
      return `¿Relanzar el agente sobre ${ref}?`
    case 'retry':
      return `¿Reintentar ${ref}?`
    case 'stop':
      return `¿Detener la ejecución de ${ref}?`
    case 'rerun_review':
      return `¿Volver a correr el reviewer sobre el PR de ${ref}?`
  }
}

/** La acción principal de cada caso — una sola por card. El resto son neutras. */
const PRIMARY_BY_KIND: Partial<Record<InboxKind, TaskAction>> = {
  merge: 'merge',
  review: 'rerun_review',
  prd: 'approve_prd',
  doubt: 'answer_and_unblock',
  prerequisite: 'answer_and_unblock',
  stale: 'relaunch',
  crash: 'retry',
}

export function primaryAction(kind: InboxKind): TaskAction | undefined {
  return PRIMARY_BY_KIND[kind]
}

/** Cómo se decide cada grupo — el texto de la leyenda. */
export const LEGEND: readonly { group: InboxGroup; rules: string[]; order?: string }[] = [
  {
    group: 'need',
    rules: [
      'Listo para mergear: status Review + label reviewed.',
      'Review sin aprobar: status Review sin reviewed — pase lo que pase con la tarea (salvo mientras el reviewer corre). Se puede re-ejecutar el review.',
      'PRD para aprobar: status Refined.',
      'El agente tiene una duda: blocked y el agente cerró por su salida `doubt` (o por la de error).',
      'Le falta una pieza: blocked y el agente cerró por su salida `prerequisite` — algo que no existe o no cerró todavía.',
      'Sin movimiento: Refine o Build, sin blocked, sin ejecución corriendo ni en cola, más de 24 h sin cambios.',
    ],
    order: 'Orden: lo más cerca de Done primero; dentro de cada caso, lo más viejo arriba.',
  },
  {
    group: 'fail',
    rules: [
      'La última ejecución quedó failed por el runner o el provider (presupuesto, crash, timeout), no por decisión del agente.',
    ],
  },
  {
    group: 'run',
    rules: ['Ejecución running, o pausada en wait-ci (se ve como esperando CI).'],
  },
  {
    group: 'queue',
    rules: [
      'Ejecución encolada detrás de otra (exclusive), o blocked por otro issue vía mark_blocked_by.',
    ],
  },
]

export const LEGEND_HIDDEN =
  'No se muestra: Backlog, Todo, Done y lo que nadie tocó todavía. Para eso está el board.'
