import type { AssistantScope, ImprovementProposal } from '@ia-flow/shared'

// El «¿Por qué?» de una mejora: de qué habla el asistente (la tarea que la originó, o todo el runner
// si no sale de una) y el contexto que viaja delante de la primera pregunta sin mostrarse —la
// mejora entera y cómo ajustarla—, igual que el menú de Mac (`AssistantModel.preamble`). Puro.

const BODY_MAX = 4000

export function whyScope(improvement: ImprovementProposal): AssistantScope {
  return improvement.task_ref ? { kind: 'task', ref: improvement.task_ref } : { kind: 'general' }
}

export function whyContext(improvement: ImprovementProposal): string {
  const body =
    improvement.body.length > BODY_MAX
      ? `${improvement.body.slice(0, BODY_MAX)}… [recortado]`
      : improvement.body
  const origin = [
    improvement.pr_url ? `PR ${improvement.pr_url}` : null,
    improvement.execution_id ? `ejecución ${improvement.execution_id}` : null,
  ]
    .filter(Boolean)
    .join(', ')
  const about = improvement.task_ref ? `sobre ${improvement.task_ref}` : 'sin una tarea de origen'
  const evidence = improvement.task_ref
    ? 'Para contestar, mira la ejecución del agente (get_task y get_trace) y apóyate en lo que muestra la traza.'
    : 'No sale de una tarea: para contestar, apóyate en la config y en lo que sabés del runner.'
  return [
    `Pregunto por la mejora ${improvement.id}, que propuso el agente «${improvement.agent}» ${about}${origin ? ` (${origin})` : ''}. ` +
      `Se abriría como issue en ${improvement.repo} (${improvement.target}). Si te pido ajustarla, usá ` +
      `assistant_revise_improvement con id ${improvement.id}; si hace falta otra mejora, assistant_add_improvement ` +
      `basada en ${improvement.id}. No me pegues el issue en la respuesta: lo leo en la card.`,
    `Título: ${improvement.title}`,
    `Razón que dio: ${improvement.reason}`,
    'Cuerpo propuesto:',
    body,
    '',
    evidence,
    '',
    'Mi pregunta:',
  ].join('\n')
}

/** Las preguntas de arranque, como en el menú. */
export const WHY_QUESTIONS = [
  '¿Por qué propusiste esto?',
  '¿Qué viste en la ejecución que lo justifica?',
  '¿Qué pasa si no se hace?',
] as const
