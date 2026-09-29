import { createEvent, EventBus, FunctionAction } from '@ia-flow/agent-engine'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { DefinitionPipelineSource } from '../DefinitionSource.js'
import type { StepFactory } from '../StepFactory.js'
import { MemorySource, pipelineDoc } from './memory.js'

const Node = z.strictObject({ log: z.string() })

/** Un tipo de paso propio de la app. */
class LogStepFactory implements StepFactory<z.infer<typeof Node>> {
  readonly keyword = 'log'
  readonly schema = Node
  constructor(private readonly lines: string[]) {}
  create(node: z.infer<typeof Node>) {
    return new FunctionAction({ fn: () => this.lines.push(node.log) })
  }
}

const source = (step: Record<string, unknown>) =>
  new MemorySource({
    id: 's',
    agents: [],
    pipelines: [pipelineDoc({ id: 'p', on: ['e'], do: [step] })],
  })

describe('custom step types', () => {
  it('a registered factory adds a step keyword without touching the builder', async () => {
    const lines: string[] = []
    const built = new DefinitionPipelineSource(source({ log: 'hola' }), {
      steps: [new LogStepFactory(lines)],
    })
    const [pipeline] = built.list()
    await pipeline?.execute({
      event: createEvent('e', {}),
      steps: {},
      bus: new EventBus(),
      pipelineId: 'p',
    })
    expect(lines).toEqual(['hola'])
  })

  it('validates a step against its factory schema', () => {
    expect(() => new DefinitionPipelineSource(source({ emit: 'x', typo: 1 }))).toThrow(
      /mem:pipelines\/p: do\[0\]: emit inválido/,
    )
  })
})
