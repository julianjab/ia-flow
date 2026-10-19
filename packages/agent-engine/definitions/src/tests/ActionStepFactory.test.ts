import {
  Action,
  createEvent,
  EventBus,
  type PipelineExecutionContext,
  ProviderRegistry,
  type Tool,
} from '@ia-flow/agent-engine'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { DefinitionPipelineSource } from '../DefinitionSource.js'
import { MemorySource, pipelineDoc } from './memory.js'

const UpdateInput = z.strictObject({
  status: z.string().optional(),
  fields: z.record(z.string(), z.string()).optional(),
  labels: z.array(z.string()).optional(),
})

/** Un `update_issue` de juguete: guarda lo que recibe. */
class Update extends Action<typeof UpdateInput> {
  readonly description = 'actualiza el issue'
  readonly input = UpdateInput
  readonly received: unknown[] = []

  constructor() {
    super({ id: 'update' })
  }

  async execute(input: z.infer<typeof UpdateInput>, _ctx: PipelineExecutionContext) {
    this.received.push(input)
    return 'ok'
  }
}

/** El agente elige `exit` mandando `submitted` en su `submit_<exit>`; guarda el schema de cada
 *  `submit_*` que vio. */
function setup(exit: string, submitted: Record<string, unknown> = {}) {
  const update = new Update()
  const schemas: Record<string, Tool['inputSchema']> = {}
  // Lo que el provider real le devolvería al modelo si el submit no valida.
  const rejected: string[] = []
  const providers = new ProviderRegistry().register({
    id: 'fake',
    run: async (ctx) => {
      for (const tool of ctx.tools) schemas[tool.name] = tool.inputSchema
      try {
        await ctx.tools.find((tool) => tool.name === `submit_${exit}`)?.handler(submitted)
      } catch (err) {
        rejected.push((err as Error).message)
      }
      return { outcome: 'success' }
    },
  })
  const source = new DefinitionPipelineSource(
    new MemorySource({
      id: 's',
      agents: [
        {
          path: 'mem:agents/refiner',
          doc: {
            id: 'refiner',
            provider: 'fake',
            prompt: 'p',
            routes: {
              to_functional: {
                to: { action: 'update', with: { fields: { 'Task Type': 'Functional' } } },
              },
              free: { to: { action: 'update' } },
            },
          } as never,
        },
      ],
      pipelines: [pipelineDoc({ id: 'refine', on: ['refine'], do: [{ agent: 'refiner' }] })],
    }),
    { providers, actions: { update } } as never,
  )
  const run = async () => {
    const [pipeline] = source.list()
    await pipeline?.execute({
      event: createEvent('refine', {}),
      steps: {},
      bus: new EventBus(),
      pipelineId: 'refine',
    })
  }
  return { update, schemas, rejected, run }
}

const keysOf = (schema: Tool['inputSchema'] | undefined) =>
  Object.keys((schema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {})

describe('ActionStepFactory — destinos de una salida', () => {
  it('con `with`, el destino es de la config: el modelo no completa nada de él', async () => {
    const { update, schemas, run } = setup('to_functional')

    await run()

    expect(keysOf(schemas.submit_to_functional)).not.toContain('update')
    expect(update.received).toEqual([{ fields: { 'Task Type': 'Functional' } }])
  })

  it('el modelo no puede sumarle un status inventado a una salida con `with`', async () => {
    const { update, rejected, run } = setup('to_functional', {
      update: { status: 'Functional Refine' },
    })

    // El provider real le devuelve el rechazo al modelo para que reintente; este falso no
    // reintenta, así que la corrida termina sin salida.
    await expect(run()).rejects.toThrow(/sin elegir salida/)

    expect(rejected).toEqual([expect.stringMatching(/Unrecognized key: "update"/)])
    expect(update.received).toEqual([])
  })

  it('sin `with`, el destino sigue abierto: el modelo completa su input', async () => {
    const { update, schemas, run } = setup('free', { update: { labels: ['x'] } })

    await run()

    expect(keysOf(schemas.submit_free)).toContain('update')
    expect(update.received).toEqual([{ labels: ['x'] }])
  })
})
