/**
 * Las mejoras que propone un agente fuera de una conversación —el de la retrospectiva, al mergear
 * el PR de una tarea—: quedan en la bandeja hasta que una persona las abre como issue (con SU
 * login de GitHub) o las descarta. El agente no crea nada.
 */
import { z } from 'zod'

/**
 * Dónde se arregla lo que encontró, y por eso en qué repo se abre el issue (lo resuelve el runner,
 * no el modelo):
 * - `docs`: la documentación del repo de la tarea (`AGENTS.md`, `CLAUDE.md`, el README).
 * - `config`: la config del deploy del runner (agentes, prompts, pipelines).
 * - `engine`: el runner o el engine (ia-flow).
 */
export const ImprovementTargetSchema = z.enum(['docs', 'config', 'engine'])
export type ImprovementTarget = z.infer<typeof ImprovementTargetSchema>

export const ImprovementStatusSchema = z.enum(['open', 'opened', 'dismissed'])
export type ImprovementStatus = z.infer<typeof ImprovementStatusSchema>

export const ImprovementProposalSchema = z.object({
  id: z.string(),
  created_at: z.string(),
  /** La tarea de la que sale (`owner/repo#n`). Sin ella, una mejora de config o del engine que se
   *  propuso desde el chat general o de un proyecto. */
  task_ref: z.string().optional(),
  /** El PR mergeado que la disparó. */
  pr_url: z.string().optional(),
  /** El agente que la propuso y su ejecución (la evidencia). */
  agent: z.string(),
  execution_id: z.string().optional(),
  target: ImprovementTargetSchema,
  /** `owner/repo` donde se abre. */
  repo: z.string(),
  title: z.string(),
  body: z.string(),
  labels: z.array(z.string()).optional(),
  reason: z.string(),
  status: ImprovementStatusSchema,
  /** El issue abierto (`opened`). */
  issue_url: z.string().optional(),
  /** Quién la abrió o la descartó, y cuándo. */
  decided_by: z.string().optional(),
  decided_at: z.string().optional(),
  /** Las columnas en que puede entrar su issue al abrirla, si su repo tiene un board (el de un
   *  proyecto del runner o uno por labels). Lo agrega el runner al listarla: no se guarda. */
  columns: z.array(z.string()).optional(),
})
export type ImprovementProposal = z.infer<typeof ImprovementProposalSchema>

/** `GET /api/improvements?status=`: las de la bandeja, la más nueva primero. */
export const ImprovementListSchema = z.object({ items: z.array(ImprovementProposalSchema) })
export type ImprovementList = z.infer<typeof ImprovementListSchema>

/** `POST /api/improvements/:id/open`: la columna en que entra el issue, una de `columns` (sin ella,
 *  la de entrada del board). */
export const ImprovementOpenRequestSchema = z.object({ status: z.string().min(1).optional() })
export type ImprovementOpenRequest = z.infer<typeof ImprovementOpenRequestSchema>

/** `POST /api/improvements/:id/{open,dismiss}`. */
export const ImprovementDecisionResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  proposal: ImprovementProposalSchema.optional(),
})
export type ImprovementDecisionResult = z.infer<typeof ImprovementDecisionResultSchema>
