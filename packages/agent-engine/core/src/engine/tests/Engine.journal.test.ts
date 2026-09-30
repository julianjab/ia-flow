import { describe, expect, it } from 'vitest'
import { Agent } from '../../agent/Agent.js'
import { ProviderRegistry, type ProviderRunContext } from '../../agent/Provider.js'
import { Condition } from '../../condition/Condition.js'
import { createEvent } from '../../events/DomainEvent.js'
import { EventBus } from '../../events/EventBus.js'
import { FunctionAction } from '../../pipeline/actions/FunctionAction.js'
import { Pipeline } from '../../pipeline/Pipeline.js'
import type { DispatchJournal, DispatchRecord } from '../DispatchJournal.js'
import { Engine } from '../Engine.js'
import { InMemoryExecutionStore } from '../InMemoryExecutionStore.js'
import { StaticPipelineSource } from '../PipelineSource.js'

const noop = () => new FunctionAction({ fn: () => undefined })
const pipeline = (id: string, extra: Partial<ConstructorParameters<typeof Pipeline>[0]> = {}) =>
  new Pipeline({ id, on: ['build'], do: [noop()], ...extra })

function recording(): DispatchJournal & { entries: DispatchRecord[] } {
  const entries: DispatchRecord[] = []
  return { entries, record: (entry) => entries.push(entry) }
}

describe('Engine dispatch journal', () => {
  it('records what each listening pipeline did: ran, mismatch, lost to an exclusive', async () => {
    const journal = recording()
    const engine = new Engine({
      bus: new EventBus(),
      pipelines: new StaticPipelineSource(
        [
          pipeline('first', { position: 0 }),
          pipeline('exclusive', { position: 1, exclusive: true }),
          pipeline('later', { position: 2 }),
          pipeline('off', { enabled: false }),
          pipeline('other-type', { on: ['label'] }),
        ],
        { id: 'proj' },
      ),
      dispatchJournal: journal,
    })
    const event = createEvent('build', {})

    expect(await engine.dispatch(event)).toBe('dispatched')

    // Dos anotaciones del mismo evento: la prevista, apenas hay plan, y la final.
    expect(journal.entries).toHaveLength(2)
    expect(journal.entries[0]?.outcome).toBe('dispatched')
    const entry = journal.entries.at(-1)
    expect(entry?.event).toBe(event)
    expect(entry?.outcome).toBe('dispatched')
    expect(entry?.executionId).toBeUndefined()
    // La que escucha otro tipo no aparece: sería ruido.
    expect(entry?.decisions).toEqual([
      { pipelineId: 'first', sourceId: 'proj', verdict: 'ran' },
      { pipelineId: 'exclusive', sourceId: 'proj', verdict: 'ran' },
      {
        pipelineId: 'later',
        sourceId: 'proj',
        verdict: 'lost_to_exclusive',
        reason: 'la tapa la exclusive "exclusive"',
      },
      { pipelineId: 'off', sourceId: 'proj', verdict: 'mismatch', reason: 'deshabilitada' },
    ])
  })

  it('a source without id records an empty sourceId, and a when that fails is a mismatch', async () => {
    const journal = recording()
    const engine = new Engine({
      bus: new EventBus(),
      pipelines: new StaticPipelineSource([
        pipeline('gated', {
          when: Condition.fromRows([{ field: 'ready', op: 'eq', value: true }]),
        }),
      ]),
      dispatchJournal: journal,
    })

    expect(await engine.dispatch(createEvent('build', { ready: false }))).toBe('skipped')
    const decision = journal.entries[0]?.decisions[0]
    expect(decision).toMatchObject({ pipelineId: 'gated', sourceId: '', verdict: 'mismatch' })
    expect(decision?.reason).toBeTruthy()
  })

  it('records an event dropped by maxEventDepth as skipped, with no decisions', async () => {
    const journal = recording()
    const engine = new Engine({
      bus: new EventBus(),
      pipelines: new StaticPipelineSource([pipeline('a')]),
      maxEventDepth: 1,
      dispatchJournal: journal,
    })

    expect(await engine.dispatch(createEvent('build', {}, { depth: 1 }))).toBe('skipped')
    expect(journal.entries).toEqual([
      expect.objectContaining({ outcome: 'skipped', decisions: [] }),
    ])
  })

  it('records a dispatch that throws as error, with the message, and rethrows', async () => {
    const journal = recording()
    const engine = new Engine({
      bus: new EventBus(),
      pipelines: new StaticPipelineSource([
        new Pipeline({
          id: 'boom',
          on: ['build'],
          do: [
            new FunctionAction({
              fn: () => {
                throw new Error('kaput')
              },
            }),
          ],
        }),
      ]),
      dispatchJournal: journal,
    })

    await expect(engine.dispatch(createEvent('build', {}))).rejects.toThrow(/failed/)
    expect(journal.entries).toHaveLength(2)
    const last = journal.entries.at(-1)
    expect(last?.outcome).toBe('error')
    expect(last?.error).toContain('kaput')
    expect(last?.decisions).toEqual([{ pipelineId: 'boom', sourceId: '', verdict: 'ran' }])
  })

  it('records an error from reading the rules, with no decisions', async () => {
    const journal = recording()
    const engine = new Engine({
      bus: new EventBus(),
      pipelines: {
        list: () => {
          throw new Error('yaml roto')
        },
      },
      dispatchJournal: journal,
    })

    await expect(engine.dispatch(createEvent('build', {}))).rejects.toThrow('yaml roto')
    expect(journal.entries[0]).toMatchObject({
      outcome: 'error',
      error: 'yaml roto',
      decisions: [],
    })
  })

  it('a journal that throws never breaks the dispatch', async () => {
    const ran: string[] = []
    const engine = new Engine({
      bus: new EventBus(),
      pipelines: new StaticPipelineSource([
        new Pipeline({
          id: 'a',
          on: ['build'],
          do: [new FunctionAction({ fn: () => ran.push('a') })],
        }),
      ]),
      dispatchJournal: {
        record: () => {
          throw new Error('disco lleno')
        },
      },
    })

    expect(await engine.dispatch(createEvent('build', {}))).toBe('dispatched')
    expect(ran).toEqual(['a'])
  })

  it('stamps the execution the event opened, and the one it was injected into', async () => {
    const journal = recording()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let started!: () => void
    const running = new Promise<void>((resolve) => {
      started = resolve
    })
    const registry = new ProviderRegistry().register({
      id: 'fake',
      run: async (ctx: ProviderRunContext) => {
        started()
        await gate
        ctx.inbox?.()
        return { outcome: 'success' }
      },
    })
    const implementer = new Agent(
      { id: 'implementer', provider: 'fake', prompt: 'p', injects: [{ on: ['issue_comment'] }] },
      registry,
    )
    const store = new InMemoryExecutionStore()
    const engine = new Engine({
      bus: new EventBus(),
      pipelines: new StaticPipelineSource([
        new Pipeline({ id: 'build', on: ['build'], do: [implementer] }),
      ]),
      executions: store,
      dispatchJournal: journal,
    })
    const scope = { projectId: 'p', issue: 'o/r#1' }

    const buildEvent = createEvent('build', {}, { scope })
    const build = engine.dispatch(buildEvent)
    await running
    // Mientras el agente corre, el evento ya está anotado con lo previsto.
    expect(journal.entries.at(-1)).toMatchObject({ event: buildEvent, outcome: 'dispatched' })
    const executionId = store.current(
      JSON.stringify([
        ['issue', 'o/r#1'],
        ['projectId', 'p'],
      ]),
    )?.id
    expect(executionId).toBeTruthy()

    const commentEvent = createEvent('issue_comment', {}, { scope })
    expect(await engine.dispatch(commentEvent)).toBe('injected')
    release()
    expect(await build).toBe('dispatched')

    const lastOf = (event: unknown) =>
      journal.entries.filter((entry) => entry.event === event).at(-1)
    const comment = lastOf(commentEvent)
    const opened = lastOf(buildEvent)
    expect(comment).toMatchObject({ outcome: 'injected', executionId, decisions: [] })
    // La ejecución ya cerró cuando el despacho termina: igual queda la que abrió.
    expect(opened).toMatchObject({ outcome: 'dispatched', executionId })
  })

  it('explain gives the same decisions without running or recording anything', async () => {
    const journal = recording()
    const ran: string[] = []
    const engine = new Engine({
      bus: new EventBus(),
      pipelines: new StaticPipelineSource([
        new Pipeline({
          id: 'a',
          on: ['build'],
          do: [new FunctionAction({ fn: () => ran.push('a') })],
        }),
        pipeline('off', { enabled: false }),
      ]),
      dispatchJournal: journal,
    })

    expect(await engine.explain(createEvent('build', {}))).toEqual([
      { pipelineId: 'a', sourceId: '', verdict: 'ran' },
      { pipelineId: 'off', sourceId: '', verdict: 'mismatch', reason: 'deshabilitada' },
    ])
    expect(ran).toEqual([])
    expect(journal.entries).toEqual([])
  })
})
