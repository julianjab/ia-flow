import {
  type Action,
  ActionStep,
  Condition,
  hasTemplate,
  type Runnable,
} from '@ia-flow/agent-engine'
import { z } from 'zod'
import type { StepBuildContext, StepFactory } from '../StepFactory.js'
import { CommonStepShape } from '../schema.js'

const Node = z.strictObject({
  action: z.string().min(1),
  /** El input que fija la config: el agente no lo ve. Con `{{...}}`, se resuelve al correr. */
  with: z.record(z.string(), z.unknown()).optional(),
  /** Para una acción que el catálogo arma a pedido (`ActionProvider`). */
  options: z.record(z.string(), z.unknown()).optional(),
  ...CommonStepShape,
})

/**
 * `{ action: addLabel, with: { label: blocked } }`: una acción del catálogo. Un `with` fijo se
 * valida al cargar (`Action.bind`); uno con `{{...}}` se resuelve en cada corrida (`ActionStep`).
 *
 * Con `with`, el paso es de la config: va envuelto en un `ActionStep`, que no le ofrece input al
 * modelo. Si quedara como `BoundAction`, una salida (`to: { action: update_issue, with: { fields:
 * … } }`) le dejaba completar el resto del input en su `submit_<salida>`: el refiner de
 * subscriptions#1905 mandó `status: Functional Refine`, una columna que no existe, y el update
 * entero falló. Sin `with`, la acción sigue abierta: el modelo completa su input.
 */
export class ActionStepFactory implements StepFactory<z.infer<typeof Node>> {
  readonly keyword = 'action'
  readonly schema = Node

  create(node: z.infer<typeof Node>, context: StepBuildContext): Runnable {
    const built = context.action(node.action, node.options)
    if (Array.isArray(built)) {
      throw new Error(
        `la acción "${node.action}" arma ${built.length} acciones: como paso tiene que ser una sola`,
      )
    }
    const templated = node.with !== undefined && hasTemplate(node.with)
    const own =
      node.id !== undefined ||
      node.when !== undefined ||
      node.whenText !== undefined ||
      node.continueOnError
    if (!node.with && !own) return built
    const action: Action =
      node.with && !templated ? built.bind(node.with as Partial<unknown>) : built
    return new ActionStep({
      action,
      with: templated ? (node.with as Record<string, unknown>) : {},
      id: node.id ?? built.id,
      when: [...built.when, ...Condition.fromRows(node.when)],
      ...context.whenText(node.whenText),
      continueOnError: node.continueOnError ?? built.continueOnError,
    })
  }
}
