/**
 * `taskActions:` de `project.yaml`: lo que una persona puede pedirle a una tarea desde cualquier
 * cliente (la web, el asistente). Cada una es una cadena de actions del catálogo —las mismas que
 * usa un pipeline— con una guarda de cuándo aplica. El runner la evalúa y la ejecuta; quién la
 * muestra y cómo es asunto del cliente.
 *
 * ```yaml
 * taskActions:
 *   answer_and_unblock:
 *     label: Responder y destrabar
 *     available:
 *       - { field: item.labels, op: contains, value: blocked }
 *     input: { comment: required }
 *     steps:
 *       - { action: post_user_comment, with: { body: '{{input.comment}}' } }
 *       - { action: update_issue, with: { removeLabels: [blocked] } }
 *       - { action: update_issue, with: { status: '{{task.resume_stage}}' } }
 * ```
 */
import { ConditionRows } from '@ia-flow/agent-engine-definitions'
import { z } from 'zod'

const StepSchema = z.strictObject({
  /** Una action del catálogo del proyecto (`update_issue`, `post_user_comment`…). */
  action: z.string().min(1),
  /** Su input; los `{{…}}` se resuelven al correr contra `input.*`, `task.*` y la card. */
  with: z.record(z.string(), z.unknown()).default({}),
  /** Si no se cumple, el paso se salta. */
  when: ConditionRows.optional(),
})

export const TaskActionDefSchema = z.strictObject({
  /** El texto del botón. */
  label: z.string().min(1),
  /** Cuándo se ofrece: filas como el `when` de una pipeline, sobre la card (`item.*`: status,
   *  labels, blocked…) y su última ejecución (`run.*`: exit, failure_by, status). Sin filas, se
   *  ofrece siempre. */
  available: ConditionRows.default([]),
  /** Lo que pide a la persona. Hoy, un comentario. */
  input: z.strictObject({ comment: z.enum(['required', 'optional']) }).optional(),
  /** La pregunta de confirmación; sin ella, la web usa una genérica. */
  confirm: z.string().min(1).optional(),
  steps: z.array(StepSchema).min(1),
})
export type TaskActionDef = z.infer<typeof TaskActionDefSchema>

export const TaskActionsSchema = z.record(
  z.string().regex(/^[a-z][a-z0-9_]*$/),
  TaskActionDefSchema,
)
export type TaskActionDefs = z.infer<typeof TaskActionsSchema>
