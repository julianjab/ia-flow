/**
 * `inbox:` de `runner.yaml`: con qué criterio el runner arma la bandeja (qué label es "bloqueada",
 * qué status es "Refined"…) y cuánto guarda lo que pasó. Todo tiene default: un `runner.yaml` sin
 * esta sección funciona igual. El asistente es un agente (`sources.capabilities.assistant`).
 */
import { z } from 'zod'

export const InboxSection = z.strictObject({
  labels: z
    .strictObject({
      /** La que pone el `onError` de un proyecto: la corrida terminó mal y espera a un humano. */
      blocked: z.string().min(1).default('blocked'),
      /** La que pone el reviewer al aprobar: el PR espera merge humano. */
      reviewed: z.string().min(1).default('reviewed'),
      /** La que pone una sesión local de Claude Code al tomar la task (`board.py claim` del plugin
       *  ai-development-flow; p. ej. `aiflow-local`). El `when` del intake la excluye; con esto,
       *  además, al ponerla el runner suelta lo que tenía vivo en la task (ejecución, pausa,
       *  corridas en cola), no la relanza desde la bandeja y la muestra como `local`. Sin esto, el
       *  runner no conoce el concepto. */
      local: z.string().min(1).optional(),
    })
    .prefault({}),
  /** Los nombres de las columnas del board que la bandeja entiende. */
  statuses: z
    .strictObject({
      /** Lo que espera a que alguien lo arranque: lo que la bandeja ofrece para alimentar el
       *  pipeline (`feed`). */
      todo: z.string().min(1).default('Todo'),
      refine: z.string().min(1).default('Refine'),
      refined: z.string().min(1).default('Refined'),
      build: z.string().min(1).default('Build'),
      review: z.string().min(1).default('Review'),
    })
    .prefault({}),
  /** Cuántas horas sin movimiento hacen "sin movimiento" a una card en Refine o Build. */
  staleHours: z.number().positive().default(24),
  /** Cuántos días se guardan los eventos, las trazas y las ejecuciones cerradas. */
  retentionDays: z.number().int().positive().default(14),
  /** Cuántos días sin tocar se guarda una conversación del asistente. */
  conversationRetentionDays: z.number().int().positive().default(90),
  /** Cuánto de un comentario queda en el resumen de un evento. */
  commentExcerpt: z.number().int().min(0).default(140),
  /** Cómo se mergea un PR desde la bandeja. */
  mergeMethod: z.enum(['merge', 'squash', 'rebase']).default('squash'),
  /** Los repos cuyo board lleva OTRO runner por labels (`board: { kind: issues }`): en qué
   *  columnas puede entrar el issue de una mejora, cada una con su label, en el orden en que se
   *  ofrecen (`{ 'julianjab/ia-flow': { Todo: 'status:todo', Refine: 'status:refine' } }`). Un repo
   *  de un proyecto de este runner no va acá: entra a su board. */
  issueBoards: z
    .record(
      z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'owner/repo'),
      z.record(z.string().min(1), z.string().min(1)),
    )
    .default({}),
})
export type InboxSettings = z.infer<typeof InboxSection>
