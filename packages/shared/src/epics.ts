/**
 * Una épica con sus sub-issues (`GET /api/tasks/:owner/:repo/:n/epic`): lo que se ve al abrirla
 * desde el chip de una tarea. Cada hijo trae su estado en GitHub y, si está en un board del
 * runner, su columna.
 */
import { z } from 'zod'
import { TaskEpicSchema } from './inbox.js'

export const EpicChildSchema = z.object({
  /** `owner/repo#n` */
  ref: z.string(),
  title: z.string(),
  url: z.string(),
  state: z.enum(['open', 'closed']),
  /** Su columna del board; un hijo fuera de los boards del runner no la trae. */
  status: z.string().optional(),
  /** Los issues abiertos que lo bloquean (`owner/repo#n`). */
  blocked_by: z.array(z.string()).optional(),
  pr: z.object({ number: z.number(), url: z.string() }).optional(),
})
export type EpicChild = z.infer<typeof EpicChildSchema>

export const EpicDetailSchema = z.object({
  epic: TaskEpicSchema.extend({ url: z.string() }),
  /** En el orden de GitHub (el de la épica). */
  children: z.array(EpicChildSchema),
})
export type EpicDetail = z.infer<typeof EpicDetailSchema>
