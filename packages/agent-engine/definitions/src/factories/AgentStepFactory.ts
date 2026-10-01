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
})

/**
 * `{ agent: implementer }`: el agente de la fuente (`agents/*.yaml`) con ese id. Con `brief` o
 * `when`, una instancia propia de este paso (el mismo agente, con eso agregado); sin ellos, la
 * compartida por toda la fuente.
 */
export class AgentStepFactory implements StepFactory<z.infer<typeof Node>> {
  readonly keyword = 'agent'
  readonly schema = Node

  create(node: z.infer<typeof Node>, context: StepBuildContext): Agent {
    if (node.brief === undefined && node.when === undefined && node.whenText === undefined) {
      return context.agent(node.agent)
    }
    return context.agent(node.agent, {
      ...(node.brief !== undefined ? { brief: node.brief } : {}),
      ...(node.when ? { when: Condition.fromRows(node.when) } : {}),
      ...context.whenText(node.whenText),
    })
  }
}
