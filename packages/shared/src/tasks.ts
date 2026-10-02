/**
 * Los HECHOS de cada tarea, sin clasificar: lo que el runner sabe de una card y de sus corridas,
 * más qué acciones aplican ahora (`taskActions` de su proyecto). `GET /api/tasks`.
 *
 * Qué es una "decisión", en qué orden va y cómo se llama cada una NO se dice acá: lo decide el
 * dashboard de quien mira (la web), con un `when` sobre estos mismos hechos. El runner no sabe que
 * existe una pantalla; un runner sin web publica lo mismo.
 */
import { z } from 'zod'
import { ExecutionSummarySchema, InboxProjectSchema, TaskActionDefSchema } from './inbox.js'

/** La raíz sobre la que se evalúa un `when` (de una acción del runner o de un dashboard) y se
 *  resuelve una plantilla: estas claves, en este orden de prioridad de significado. */
export const TaskFactsSchema = z.object({
  /** La card: `item.status`, `item.labels`, `item.blocked`, `item.type`, `item.repos`. */
  item: z.object({
    status: z.string().optional(),
    type: z.string(),
    repos: z.array(z.string()),
    labels: z.array(z.string()),
    /** Hay prerrequisitos abiertos. */
    blocked: z.boolean(),
  }),
  /** Su última corrida cerrada (vacío si no hubo): `exit`, `status`, `failure_by`, `agent`, `summary`. */
  run: z.record(z.string(), z.string()),
  /** La corrida viva (vacío si no hay): `status` (running|paused), `agent`, `pause_id`, `expires_at`, `ci`. */
  live: z.record(z.string(), z.string()),
  queue: z.object({ waiting: z.boolean() }),
  task: z.object({
    /** Horas desde lo último que la tocó (card, evento o corrida). */
    idle_hours: z.number(),
    /** Horas que lleva en el estado en que está (desde que cerró su última corrida, o su card). */
    waiting_hours: z.number(),
    /** Cuántas tareas destraba si se cierra. */
    unlocks: z.number(),
    /** Cuántos issues la bloquean. */
    blocked_by: z.number(),
  }),
  /** Su PR abierto, si tiene (`pr.number`). */
  pr: z.object({ number: z.number(), url: z.string() }).optional(),
})
export type TaskFacts = z.infer<typeof TaskFactsSchema>

export const TaskFactSchema = TaskFactsSchema.extend({
  /** `owner/repo#n` */
  ref: z.string(),
  project_id: z.string(),
  title: z.string(),
  url: z.string(),
  updated_at: z.string(),
  /** Los issues que la bloquean (`owner/repo#n`). */
  blocked_by_refs: z.array(z.string()),
  /** La corrida viva y la última cerrada, completas: tokens, fechas, el motivo de un fallo. */
  live_run: ExecutionSummarySchema.optional(),
  last_run: ExecutionSummarySchema.optional(),
  /** Lo que el runner ofrece ahora sobre esta tarea (sus `taskActions` cuyo `available` se cumple). */
  actions: z.array(z.string()),
  action_defs: z.array(TaskActionDefSchema),
})
export type TaskFact = z.infer<typeof TaskFactSchema>

/** Qué tiene el runner para correr: lo que mira un panel de "qué le das al pipeline". */
export const RunnerCapacitySchema = z.object({
  running: z.number(),
  waiting: z.number(),
  paused: z.number(),
  /** `engine.executions.maxConcurrent`; sin tope, ausente. */
  max_concurrent: z.number().optional(),
  /** Lugares libres: `max_concurrent - running`; sin tope, ausente. */
  free: z.number().optional(),
})
export type RunnerCapacity = z.infer<typeof RunnerCapacitySchema>

export const TasksSchema = z.object({
  generated_at: z.string(),
  projects: z.array(InboxProjectSchema),
  /** TODAS las cards abiertas del board —también Backlog y Todo—: qué es una decisión lo dice el
   *  dashboard, no esta lista. */
  tasks: z.array(TaskFactSchema),
  capacity: RunnerCapacitySchema,
})
export type Tasks = z.infer<typeof TasksSchema>
