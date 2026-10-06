import { describe, expect, it } from 'vitest'
import { Agent } from '../../agent/Agent.js'
import { ProviderRegistry, type ProviderRunContext } from '../../agent/Provider.js'
import { YIELD_TOOL_NAME } from '../../agent/YieldTool.js'
import type { EventFilterProps } from '../../condition/EventFilter.js'
import { createEvent, type DomainEvent } from '../../events/DomainEvent.js'
import { EventBus } from '../../events/EventBus.js'
import { FunctionAction } from '../../pipeline/actions/FunctionAction.js'
import { ParallelGroup } from '../../pipeline/ParallelGroup.js'
import { Pipeline } from '../../pipeline/Pipeline.js'
import { INTERRUPTION_STEP, type Runnable } from '../../pipeline/Runnable.js'
import { Engine, scopeExecutionKey } from '../Engine.js'
import { InMemoryExecutionStore } from '../InMemoryExecutionStore.js'
import { StaticPipelineSource } from '../PipelineSource.js'

const TASK = { projectId: 'p', repo: 'la-haus/lh-seller-v2-frontend', issue: 4200 }
const event = (type: string, payload: Record<string, unknown> = {}): DomainEvent =>
  createEvent(type, payload, { scope: TASK, depth: 1 })

/** El despacho decide después de leer las reglas (asincrónico). */
const decided = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * Un agente que queda en su loop hasta que el test lo suelta. Al soltarlo lee SU inbox; si le
 * avisaron que lo interrumpieron cede el turno, si no elige `exit`.
 */
function heldAgent(id: string, exit: string, injects?: EventFilterProps[]) {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let started!: () => void
  const running = new Promise<void>((resolve) => {
    started = resolve
  })
  const inbox: string[][] = []
  const registry = new ProviderRegistry().register({
    id: `fake-${id}`,
    run: async (ctx: ProviderRunContext) => {
      started()
      await gate
      const read = (await ctx.inbox?.()) ?? []
      inbox.push(read)
      const yieldTool = ctx.tools.find((tool) => tool.name === YIELD_TOOL_NAME)
      if (read.some((m) => m.includes('Interrupción')) && yieldTool) {
        await yieldTool.handler({ progress: `${id} a medias` })
        return { outcome: 'success' }
      }
      await ctx.tools.find((tool) => tool.name === `submit_${exit}`)?.handler({})
      return { outcome: 'success' }
    },
  })
  const agent = new Agent(
    {
      id,
      provider: `fake-${id}`,
      prompt: 'p',
      routes: { [exit]: {} },
      ...(injects ? { injects } : {}),
    },
    registry,
  )
  return { agent, release, running, inbox }
}

function engineWith(pipelines: Pipeline[]) {
  const store = new InMemoryExecutionStore()
  const engine = new Engine({
    bus: new EventBus(),
    pipelines: new StaticPipelineSource(pipelines),
    executions: store,
    formatMessage: (e) => `${e.type}: ${String((e.payload as { body?: string }).body)}`,
  })
  return { engine, store }
}

function journal() {
  const log: string[] = []
  const step = (id: string, record?: (ctx: Parameters<FunctionAction['fn']>[0]) => string) =>
    new FunctionAction({
      id,
      fn: (ctx) => {
        log.push(record ? record(ctx) : id)
      },
    })
  return { log, step }
}

/** Un agente que sólo anota que corrió: lo que viene después de la interrupción. */
function builder(log: string[]) {
  return new Agent(
    { id: 'builder', provider: 'b', prompt: 'p' },
    new ProviderRegistry().register({
      id: 'b',
      run: async () => {
        log.push('builder')
        return { outcome: 'success' }
      },
    }),
  )
}

const rule = (id: string, on: string, steps: Runnable[], ifRunning?: 'interrupt') =>
  new Pipeline({ id, on: [on], do: steps, ...(ifRunning ? { ifRunning } : {}) })

describe('Engine — grupo parallel', () => {
  it('un comentario lo lee sólo el miembro que lo acepta, y no arranca otra corrida', async () => {
    const { log, step } = journal()
    const reviewer = heldAgent('reviewer', 'approved', [{ on: ['issue_comment'] }])
    const e2e = heldAgent('e2e', 'passed')
    const gate = new ParallelGroup({
      id: 'gate',
      members: [reviewer.agent, e2e.agent],
      until: { all: ['approved', 'passed'] },
      routes: { passed: { to: step('slack-review') } },
    })
    const { engine } = engineWith([
      rule('review', 'review', [gate]),
      rule('comment', 'issue_comment', [step('comment-rule')]),
    ])

    const review = engine.dispatch(event('review'))
    await Promise.all([reviewer.running, e2e.running])
    await engine.dispatch(event('issue_comment', { body: 'falta un test' }))

    reviewer.release()
    e2e.release()
    await review

    expect(reviewer.inbox[0]).toEqual(['issue_comment: falta un test'])
    expect(e2e.inbox[0]).toEqual([])
    // Una regla CON agentes no corrió; ésta es una acción sola, que corre igual que siempre.
    expect(log).toEqual(['comment-rule', 'slack-review'])
  })

  it('interrumpido: cada miembro cede, el `onInterrupt` del grupo corre UNA vez y no corre ninguna salida', async () => {
    const { log, step } = journal()
    const reviewer = heldAgent('reviewer', 'approved')
    const e2e = heldAgent('e2e', 'passed')
    const gate = new ParallelGroup({
      id: 'gate',
      members: [reviewer.agent, e2e.agent],
      until: { all: ['approved', 'passed'] },
      routes: { passed: { to: step('slack-review') }, failed: { to: step('to-build') } },
      onInterrupt: {
        to: step('comment', (ctx) => {
          const report = ctx.steps[INTERRUPTION_STEP] as { agent: string; progress: string }
          return `interrumpido ${report.agent}: ${report.progress.split('\n').sort().join(' | ')}`
        }),
      },
    })
    const { engine, store } = engineWith([
      rule('review', 'review', [gate]),
      rule('build', 'status_changed', [builder(log)], 'interrupt'),
    ])

    const review = engine.dispatch(event('review'))
    await Promise.all([reviewer.running, e2e.running])
    const build = engine.dispatch(event('status_changed', { status: 'Build' }))
    await decided()
    const execution = store.current(scopeExecutionKey(event('any')) as string)
    expect(execution?.interruption?.by).toBe('build')

    reviewer.release()
    e2e.release()
    await Promise.all([review, build])

    expect(log).toEqual([
      'interrumpido gate: e2e: e2e a medias | reviewer: reviewer a medias',
      'builder',
    ])
    expect(execution?.status).toBe('superseded')
  })
})
