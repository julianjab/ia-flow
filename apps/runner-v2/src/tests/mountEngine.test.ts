import { describe, expect, it } from 'bun:test'
import { createEvent } from '@ia-tools/agent-engine'
import { interruptReason, messageTemplate, mountEngine, ownSender } from '../engine/mountEngine.js'

describe('mountEngine', () => {
  it('builds the engine from runner.yaml engine: — store by driver name, depth', () => {
    const mounted = mountEngine(
      { maxEventDepth: 3, executions: { driver: 'memory', maxConcurrent: 2 } },
      { baseDir: '/tmp', sources: [], drivers: {} },
    )
    expect(mounted.engine.maxEventDepth).toBe(3)
    expect(mounted.executions?.stats).toEqual({ running: 0, waiting: 0, paused: 0 })
    mounted.stop()
  })

  it('refuses a driver nobody registered, saying which ones there are', () => {
    expect(() =>
      mountEngine(
        { executions: { driver: 'postgres' } },
        { baseDir: '/tmp', sources: [], drivers: { 'bun-sqlite': () => ({}) as never } },
      ),
    ).toThrow(/driver "postgres" no está registrado — hay: memory, bun-sqlite/)
  })
})

describe('messageTemplate', () => {
  it('renders against the payload; empty, falls back to the default message', () => {
    const format = messageTemplate('{{message}}') as NonNullable<ReturnType<typeof messageTemplate>>
    expect(format(createEvent('issue_comment', { message: 'Comentario de @ana' }))).toBe(
      'Comentario de @ana',
    )
    expect(format(createEvent('x', { n: 1 }))).toBe('Evento x: {"n":1}')
    expect(messageTemplate(undefined)).toBeUndefined()
  })
})

describe('interrupt', () => {
  const pipeline = { id: 'build-reentry' } as never

  it('reason renders against the payload; with nothing to say, the engine default', () => {
    const reason = interruptReason('la card pasó de {{from}} a {{to}}') as NonNullable<
      ReturnType<typeof interruptReason>
    >
    expect(
      reason(createEvent('issue.status_changed', { from: 'Build', to: 'Refine' }), pipeline),
    ).toBe('la card pasó de Build a Refine')
    const empty = interruptReason('{{nope}}') as NonNullable<ReturnType<typeof interruptReason>>
    expect(empty(createEvent('x', {}), pipeline)).toBe('llegó "x" y va a correr "build-reentry"')
    expect(interruptReason(undefined)).toBeUndefined()
  })

  it("ownSenders: only an event sent by a matching login is the runner's own echo", () => {
    const own = ownSender('\\[bot\\]$') as NonNullable<ReturnType<typeof ownSender>>
    expect(own(createEvent('issue.status_changed', { sender: 'ia-flow-local[bot]' }))).toBe(true)
    expect(own(createEvent('issue.status_changed', { sender: 'julian' }))).toBe(false)
    expect(own(createEvent('issue.status_changed', {}))).toBe(false)
    expect(ownSender(undefined)).toBeUndefined()
  })
})
