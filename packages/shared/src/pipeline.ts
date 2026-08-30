import { z } from 'zod'
import { RuleSchema } from './rules.js'

// El pipeline de un ámbito: lo que está configurado, y lo que está corriendo
// encima. Una sola respuesta porque son una sola pregunta — "¿qué hace este
// proyecto y qué está haciendo ahora?" — y pedirla en dos requests obliga a la
// UI a correlacionar dos snapshots tomados en momentos distintos.

/** Un run en vuelo, ya atado a la regla que lo lanzó. */
export const RunningAgentSchema = z.object({
  taskId: z.string(),
  taskTitle: z.string().optional(),
  issueNumber: z.number().optional(),
  agentId: z.string().optional(),
  /** La regla que lo disparó. Ausente en un dispatch que no vino de una regla
   *  (un run manual, un sub-agente) — la UI lo muestra suelto en vez de
   *  colgarlo de una regla equivocada. */
  ruleId: z.string().optional(),
  runId: z.string().optional(),
  executionId: z.string().optional(),
  status: z.string(),
  /** `true` cuando lo lanzó otro agente con `run_agent`. Se dibuja anidado
   *  bajo su padre y no como un run más: no ocupa un slot del proyecto y
   *  contarlo aparte confundiría la lectura de capacidad. */
  isSubAgent: z.boolean(),
})
export type RunningAgent = z.infer<typeof RunningAgentSchema>

/** Una espera viva. Una pausa es una espera con checkpoint — misma fila. */
export const PipelineWaitSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  agentId: z.string(),
  on: z.array(z.string()),
  expiresAt: z.string(),
  /** Con checkpoint = el run está pausado y va a retomar donde iba. Sin él,
   *  el agente terminó su turno y espera para volver a arrancar. */
  isPause: z.boolean(),
})
export type PipelineWait = z.infer<typeof PipelineWaitSchema>

/**
 * Los dos errores de configuración más caros, derivados y no declarados.
 *
 * Son los que hoy son invisibles: un agente que ninguna regla nombra nunca va
 * a correr, y un status sin ninguna regla es un pozo donde los issues entran y
 * se quedan quietos. Ninguno de los dos da error en ningún lado.
 */
export const PipelineGapsSchema = z.object({
  /** Agentes del ámbito que ninguna regla habilitada nombra. */
  unusedAgents: z.array(z.string()),
  /** Statuses del proyecto sobre los que no dispara ninguna regla. */
  statusesWithoutRules: z.array(z.string()),
})
export type PipelineGaps = z.infer<typeof PipelineGapsSchema>

export const PipelineSchema = z.object({
  rules: z.array(RuleSchema),
  running: z.array(RunningAgentSchema),
  waits: z.array(PipelineWaitSchema),
  gaps: PipelineGapsSchema,
})
export type Pipeline = z.infer<typeof PipelineSchema>
