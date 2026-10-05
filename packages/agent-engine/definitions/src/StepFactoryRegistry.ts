import type { Runnable } from '@ia-flow/agent-engine'
import { z } from 'zod'
import { ActionStepFactory } from './factories/ActionStepFactory.js'
import { AgentStepFactory } from './factories/AgentStepFactory.js'
import { EmitStepFactory } from './factories/EmitStepFactory.js'
import { FunctionStepFactory } from './factories/FunctionStepFactory.js'
import { HttpStepFactory } from './factories/HttpStepFactory.js'
import { ParallelStepFactory } from './factories/ParallelStepFactory.js'
import { PauseStepFactory } from './factories/PauseStepFactory.js'
import { located } from './located.js'
import type { StepBuildContext, StepFactory } from './StepFactory.js'

/**
 * Qué tipo de paso es cada nodo del YAML: el de la primera clave que tiene una factory registrada.
 * Los tipos incluidos se registran solos; una app suma los suyos con `register`.
 */
export class StepFactoryRegistry {
  private readonly factories = new Map<string, StepFactory>()

  constructor(extra: StepFactory[] = []) {
    for (const factory of [
      new AgentStepFactory(),
      new ActionStepFactory(),
      new EmitStepFactory(),
      new HttpStepFactory(),
      new PauseStepFactory(),
      new ParallelStepFactory(),
      new FunctionStepFactory(),
      ...extra,
    ]) {
      this.register(factory)
    }
  }

  register(factory: StepFactory): this {
    this.factories.set(factory.keyword, factory)
    return this
  }

  get keywords(): string[] {
    return [...this.factories.keys()]
  }

  create(node: Record<string, unknown>, context: StepBuildContext): Runnable {
    const keyword = Object.keys(node).find((key) => this.factories.has(key))
    if (!keyword) {
      throw new Error(
        `${context.where}: no es un paso conocido — tiene que llevar una de: ${this.keywords.join(', ')}, ref`,
      )
    }
    const factory = this.factories.get(keyword) as StepFactory
    const parsed = factory.schema.safeParse(node)
    if (!parsed.success) {
      throw new Error(`${context.where}: ${keyword} inválido\n${z.prettifyError(parsed.error)}`)
    }
    return located(context.where, () => factory.create(parsed.data, context))
  }
}
