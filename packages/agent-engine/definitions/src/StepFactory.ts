import type { Action, Agent, Condition, RouteTo, Runnable, WhenText } from '@ia-flow/agent-engine'
import type { z } from 'zod'
import type { Catalogs } from './Catalogs.js'
import type { WhenTextNode } from './schema.js'

/** Un agente de la fuente ajustado a UN paso de una pipeline. */
export interface AgentVariant {
  /** Se antepone a su prompt: por qué corre en este paso. */
  brief?: string
  /** El `when` del paso: el último nivel de la cascada (pipeline → paso). */
  when?: Condition[]
  /** El `whenText` del paso; gana sobre el del agente. */
  whenText?: WhenText
}

/** Lo que una factory puede pedir mientras arma un paso. */
export interface StepBuildContext {
  readonly catalogs: Catalogs
  readonly sourceId: string
  /** El agente dueño de este nodo (su `onStart`, sus rutas, su `report`), si hay. */
  readonly agentId?: string
  /** Dónde está el nodo (archivo y ruta), para los errores. */
  readonly where: string
  /** Arma un paso anidado (ej. el destino de una rama de una pausa). */
  step(node: unknown, where: string): Runnable
  /** Arma un `to`: `end`, un paso o una lista de pasos. */
  routeTo(node: unknown, where: string): RouteTo | undefined
  /** El agente de la fuente con ese id — el compartido, o uno propio de este paso si hay `variant`. */
  agent(id: string, variant?: AgentVariant): Agent
  /** La acción del catálogo con ese nombre, armada para este nodo. */
  action(name: string, options?: Record<string, unknown>): Action | Action[]
  /** Un `whenText` del YAML resuelto (sus system prompts por id, a texto), listo para esparcir
   *  en las props de un paso: `{ whenText }`, o `{}` si no hay. */
  whenText(node: WhenTextNode | undefined): { whenText?: WhenText }
}

/**
 * Un tipo de paso del YAML: un nodo con la clave `keyword` (ej. `{ emit: issue.ready, ... }`) se
 * valida contra `schema` y se arma con `create`. Registrar una factory nueva agrega un tipo de paso
 * sin tocar el loader.
 */
export interface StepFactory<N = any> {
  readonly keyword: string
  readonly schema: z.ZodType<N>
  create(node: N, context: StepBuildContext): Runnable
}
