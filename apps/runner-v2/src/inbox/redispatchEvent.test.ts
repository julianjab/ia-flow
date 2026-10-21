import { describe, expect, it } from 'bun:test'
import { createEvent, scopeExecutionKey } from '@ia-flow/agent-engine'
import { redispatchEvent } from './redispatchEvent.js'

const scope = {
  projectId: 'lahaus-ai-flow',
  repo: 'la-haus/lh-seller-v2-frontend',
  issue: 'la-haus/lh-seller-v2-frontend#4381',
}

describe('redispatchEvent', () => {
  it('relanza con la misma clave de ejecución que un webhook de la task', () => {
    const last = { id: 'ev-1', type: 'issue.status_changed', payload: { to: 'Build' }, scope }
    const webhook = createEvent('projects_v2_item.edited', {}, { scope: { ...scope } })

    const event = redispatchEvent(last)

    // La misma clave: la segunda espera a la primera en vez de correr en paralelo.
    expect(scopeExecutionKey(event)).toBe(scopeExecutionKey(webhook))
    expect(event.scope).toEqual(scope)
  })

  it('cuelga del evento original y repite su tipo y payload', () => {
    const last = { id: 'ev-1', type: 'issue.status_changed', payload: { to: 'Build' }, scope }

    const event = redispatchEvent(last)

    expect(event.parentId).toBe('ev-1')
    expect(event.type).toBe('issue.status_changed')
    expect(event.payload).toEqual({ to: 'Build' })
  })
})
