import { describe, expect, it } from 'vitest'
import { createEvent } from '../../events/DomainEvent.js'
import { EventBus } from '../../events/EventBus.js'
import type { ExitRoutes } from '../../routing/ExitRoutes.js'
import { FunctionAction } from '../actions/FunctionAction.js'
import { PauseAction } from '../actions/PauseAction.js'
import { Pipeline } from '../Pipeline.js'
import { PipelineGraph } from '../PipelineGraph.js'
import { type PipelineExecutionContext, Runnable, type StepOutcome } from '../Runnable.js'

/** Un paso que elige salidas SIN ser un `Agent`: una regla determinística. */
class Router extends Runnable {
  constructor(
    readonly pick: string,
    private readonly routes: ExitRoutes,
  ) {
    super({ id: 'router' })
  }

  override get exitRoutes(): ExitRoutes {
    return this.routes
  }

  override outcome(output: unknown): StepOutcome {
    return { kind: 'exit', output, exit: this.pick, payload: {} }
  }

  async run(): Promise<unknown> {
    return this.pick
  }
}

const ctx = (): PipelineExecutionContext => ({
  event: createEvent('e', {}),
  steps: {},
  bus: new EventBus(),
  pipelineId: 'p',
})

describe('PipelineGraph', () => {
  it('knows up front whether runs need an execution', () => {
    const plain = new PipelineGraph({
      pipelineId: 'p',
      do: [new FunctionAction({ fn: () => undefined })],
      defaults: {},
      stepRoutes: {},
    })
    const pausing = new PipelineGraph({
      pipelineId: 'p',
      do: [new PauseAction({ id: 'wait', branches: { go: { on: ['go'] } } })],
      defaults: {},
      stepRoutes: {},
    })
    expect(plain.needsExecution).toBe(false)
    expect(pausing.needsExecution).toBe(true)
    expect(pausing.pause('wait').branchNames).toEqual(['go'])
    expect(() => pausing.pause('nope')).toThrow(/no hay una pausa "nope"/)
  })

  it('routes any step that chooses exits, not only agents', async () => {
    const ran: string[] = []
    const yes = new FunctionAction({ id: 'yes', fn: () => ran.push('yes') })
    const no = new FunctionAction({ id: 'no', fn: () => ran.push('no') })
    const router = new Router('approve', {
      routes: { approve: { to: yes }, reject: { to: no } },
    })
    const pipeline = new Pipeline({ id: 'p', on: ['e'], do: [router, yes, no] })

    const steps = await pipeline.execute(ctx())
    // `yes` y `no` son destinos: sólo corre el de la salida elegida.
    expect(ran).toEqual(['yes'])
    expect(steps.router).toBe('approve')
    expect(pipeline.needsExecution).toBe(true)
    expect(pipeline.routesOf('router').exits.map((exit) => exit.name)).toEqual([
      'approve',
      'reject',
    ])
  })
})
