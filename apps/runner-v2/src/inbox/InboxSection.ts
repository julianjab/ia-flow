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
    })
    .prefault({}),
  /** Los nombres de las columnas del board que la bandeja entiende. */
  statuses: z
    .strictObject({
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
})
export type InboxSettings = z.infer<typeof InboxSection>
