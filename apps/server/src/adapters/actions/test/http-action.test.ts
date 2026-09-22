import { describe, expect, test } from 'bun:test'
import type { ActionContext } from '@ia-flow/rules'
import { createEvent } from '@ia-flow/shared'
import { HttpAction } from '../http-action.js'

const ctx = (payload: Record<string, unknown> = {}): ActionContext =>
  ({
    event: createEvent({
      type: 'pull_request',
      source: 'github',
      scope: { projectId: 'p1' },
      payload,
    }),
    rule: { id: 'r1' },
    emit: async () => {},
  }) as unknown as ActionContext

const config = (over: Record<string, unknown> = {}) =>
  ({ action: 'http', method: 'GET', url: 'http://localhost/x', ...over }) as never

function action(fetchImpl: (...args: unknown[]) => Promise<Response>) {
  return new HttpAction({
    resolveSecrets: async (input) => input,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  })
}

describe('HttpAction — output', () => {
  test('una respuesta JSON queda disponible como output', async () => {
    const a = action(
      async () =>
        new Response(JSON.stringify({ item: { status: 'Ready' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const r = await a.execute(ctx(), config())
    expect(r.ok).toBe(true)
    expect(r.output).toEqual({ item: { status: 'Ready' } })
  })

  test('una respuesta de texto plano no deja output', async () => {
    const a = action(
      async () => new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } }),
    )
    const r = await a.execute(ctx(), config())
    expect(r.ok).toBe(true)
    expect(r.output).toBeUndefined()
  })

  test('JSON inválido con content-type JSON no revienta la acción', async () => {
    const a = action(
      async () =>
        new Response('{no es json', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const r = await a.execute(ctx(), config())
    expect(r.ok).toBe(true)
    expect(r.output).toBeUndefined()
  })

  test('una respuesta con error no tiene output', async () => {
    const a = action(
      async () =>
        new Response(JSON.stringify({ error: 'nope' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const r = await a.execute(ctx(), config())
    expect(r.ok).toBe(false)
    expect(r.output).toBeUndefined()
  })
})
