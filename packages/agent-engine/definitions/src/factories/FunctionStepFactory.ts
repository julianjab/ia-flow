import { Condition, FunctionAction, render, templateRoot } from '@ia-flow/agent-engine'
import { z } from 'zod'
import { lookup } from '../Catalogs.js'
import type { StepBuildContext, StepFactory } from '../StepFactory.js'
import { CommonStepShape } from '../schema.js'

const Node = z.strictObject({
  function: z.string().min(1),
  /** Lo que recibe la función como input, con sus `{{...}}` resueltos al correr. */
  with: z.record(z.string(), z.unknown()).optional(),
  ...CommonStepShape,
})

/**
 * `{ function: board_item, with: { items: '{{steps.items}}' } }`: una función del catálogo, como
 * `FunctionAction`. Con `with`, la función recibe esos valores como input — así una función pura
 * sirve en cualquier pipeline, sin saber de dónde salen sus datos.
 */
export class FunctionStepFactory implements StepFactory<z.infer<typeof Node>> {
  readonly keyword = 'function'
  readonly schema = Node

  create(node: z.infer<typeof Node>, context: StepBuildContext): FunctionAction {
    const fn = lookup(context.catalogs.functions, node.function, 'una función')
    const args = node.with
    return new FunctionAction({
      fn: args ? (ctx) => fn(ctx, render(args, templateRoot(ctx)) as Record<string, unknown>) : fn,
      id: node.id ?? node.function,
      when: Condition.fromRows(node.when),
      ...context.whenText(node.whenText),
      continueOnError: node.continueOnError,
    })
  }
}
