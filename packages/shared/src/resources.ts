import { z } from 'zod'

/** Cuánto se usa de algo y cuánto hay, en bytes. */
export const ResourceUsageSchema = z.object({
  used_bytes: z.number(),
  total_bytes: z.number(),
})
export type ResourceUsage = z.infer<typeof ResourceUsageSchema>

/**
 * Los recursos de una máquina del runner —el proceso del runner o un host remoto—, leídos en el
 * momento. Cada parte puede faltar (no se pudo leer, o el host es anterior).
 */
export const MachineResourcesSchema = z.object({
  /** Cuándo se leyeron. */
  at: z.string(),
  /** La memoria del contenedor (cgroup) si tiene tope; si no, la de la máquina. */
  memory: ResourceUsageSchema.extend({ source: z.enum(['cgroup', 'system']) }).optional(),
  /** La memoria que ocupa el proceso. */
  process_rss_bytes: z.number().optional(),
  /** El disco donde vive su estado (`IA_FLOW_HOME`) o sus worktrees. */
  disk: ResourceUsageSchema.extend({ path: z.string() }).optional(),
  /** La carga del último minuto y cuántas CPUs tiene (el tope del contenedor, si lo hay). */
  load: z.object({ load1: z.number(), cpus: z.number() }).optional(),
  /** Los worktrees de tareas en disco. */
  worktrees: z.number().optional(),
})
export type MachineResources = z.infer<typeof MachineResourcesSchema>

/** Un host remoto (`remote:<name>`): sus lugares y, si los manda, sus recursos. */
export const HostResourcesSchema = z.object({
  name: z.string(),
  provider: z.string(),
  max_concurrent: z.number(),
  running: z.number(),
  last_seen: z.string(),
  resources: MachineResourcesSchema.optional(),
})
export type HostResources = z.infer<typeof HostResourcesSchema>

/** `GET /api/resources`: el runner y sus hosts. */
export const RunnerResourcesSchema = z.object({
  runner: MachineResourcesSchema,
  hosts: z.array(HostResourcesSchema),
})
export type RunnerResources = z.infer<typeof RunnerResourcesSchema>
