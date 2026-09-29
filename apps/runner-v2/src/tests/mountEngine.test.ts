import { describe, expect, it } from 'bun:test'
import { createEvent } from '@ia-tools/agent-engine'
import { messageTemplate, mountEngine } from '../engine/mountEngine.js'

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
