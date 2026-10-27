import { describe, expect, it } from 'bun:test'
import { createEvent, scopeExecutionKey } from '@ia-flow/agent-engine'
import { LocalClaims } from './LocalClaims.js'

const scope = { projectId: 'p', repo: 'o/r', issue: 'o/r#7' }

describe('LocalClaims', () => {
  it('suelta la task por la misma clave que sus ejecuciones', () => {
    const cancelled: Array<[string, string]> = []
    const claims = new LocalClaims('aiflow-local')
    claims.connect({
      cancel: (key, reason) => {
        cancelled.push([key, reason])
        return { waiting: false }
      },
    })
    // Otro orden de claves, misma task.
    claims.release({ issue: 'o/r#7', repo: 'o/r', projectId: 'p' }, 'motivo')
    expect(cancelled).toEqual([
      [scopeExecutionKey(createEvent('x', {}, { scope })) ?? '', 'motivo'],
    ])
  })

  it('sin store conectado no hace nada', () => {
    expect(new LocalClaims('aiflow-local').release(scope, 'motivo')).toBeUndefined()
  })

  it('claimed: sólo con el label configurado', () => {
    expect(new LocalClaims('aiflow-local').claimed(['aiflow-local'])).toBe(true)
    expect(new LocalClaims('aiflow-local').claimed(['blocked'])).toBe(false)
    expect(new LocalClaims(undefined).claimed(['aiflow-local'])).toBe(false)
  })
})
