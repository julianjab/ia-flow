import { type Agent, Condition } from '@ia-flow/agent-engine'
import { z } from 'zod'
import type { StepBuildContext, StepFactory } from '../StepFactory.js'
import { ConditionRows, WhenTextNode } from '../schema.js'

const Node = z.strictObject({
  agent: z.string().min(1),
  /** Se antepone a su prompt en ESTE paso: por qué corre acá. */
  brief: z.string().optional(),
  /** El `when` de este paso. */
  when: ConditionRows.optional(),
  /** El gate semántico de este paso; gana sobre el del agente. */
  whenText: WhenTextNode.optional(),
  /** `null`: en este paso el engine no publica su reporte (un gate que sólo vota). */
  report: z.null().optional(),
  /** Ids de sus actions que en este paso no recibe (ej. `review_pull_request` de un gate mudo). */
  withoutActions: z.array(z.string().min(1)).min(1).optional(),
})

/**
 * `{ agent: implementer }`: el agente de la fuente (`agents/*.yaml`) con ese id. Con `brief`,
 * `when`, `whenText`, `report: null` o `withoutActions`, una instancia propia de este paso (el
 * mismo agente, con eso ajustado); sin ellos, la compartida por toda la fuente.
 */
export class AgentStepFactory implements StepFactory<z.infer<typeof Node>> {
  readonly keyword = 'agent'
  readonly schema = Node

  create(node: z.infer<typeof Node>, context: StepBuildContext): Agent {
    const own =
      node.brief !== undefined ||
      node.when !== undefined ||
      node.whenText !== undefined ||
      node.report !== undefined ||
      node.withoutActions !== undefined
    if (!own) return context.agent(node.agent)
    return context.agent(node.agent, {
      ...(node.brief !== undefined ? { brief: node.brief } : {}),
      ...(node.when ? { when: Condition.fromRows(node.when) } : {}),
      ...context.whenText(node.whenText),
      ...(node.report === null ? { withoutReport: true } : {}),
      ...(node.withoutActions ? { withoutActions: node.withoutActions } : {}),
    })
  }
}
