import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { createApiAuthMiddleware } from '../api-auth.js'

// El modo ABIERTO del guard, que es lo que hace montable el middleware en el
// server de desarrollo.
//
// La distinción con el modo fail-closed no es sobre la ruta sino sobre el
// DESPLIEGUE: la misma API con el mismo token, expuesta de dos maneras. En
// Kubernetes no protegerla no es una opción; en local el punto de partida es
// que no hay auth ninguna, así que fail-closed rompería cada setup sin token.

function appWith(opts?: { openWithoutToken?: boolean }) {
  const app = new Hono()
  app.use('/api/*', createApiAuthMiddleware(opts))
  app.get('/api/x', (c) => c.json({ ok: true }))
  return app
}

const original = process.env.IA_FLOW_API_TOKEN

beforeEach(() => {
  process.env.IA_FLOW_API_TOKEN = undefined
  delete process.env.IA_FLOW_API_TOKEN
})
afterEach(() => {
  if (original === undefined) delete process.env.IA_FLOW_API_TOKEN
  else process.env.IA_FLOW_API_TOKEN = original
})

describe('createApiAuthMiddleware — modo abierto', () => {
  test('sin token configurado, deja pasar', async () => {
    const res = await appWith({ openWithoutToken: true }).request('/api/x')
    expect(res.status).toBe(200)
  })

  // El default sigue siendo fail-closed: un guard que se apaga solo cuando
  // falta su secreto promete algo que no cumple.
  test('sin la opción, sigue siendo fail-closed', async () => {
    const res = await appWith().request('/api/x')
    expect(res.status).toBe(503)
  })

  test('con token configurado, exige el header aunque esté en modo abierto', async () => {
    process.env.IA_FLOW_API_TOKEN = 'secreto'
    const app = appWith({ openWithoutToken: true })

    expect((await app.request('/api/x')).status).toBe(401)
    expect((await app.request('/api/x', { headers: { 'x-ia-flow-token': 'otro' } })).status).toBe(
      401,
    )
    expect(
      (await app.request('/api/x', { headers: { 'x-ia-flow-token': 'secreto' } })).status,
    ).toBe(200)
  })

  test('acepta Bearer además del header propio', async () => {
    process.env.IA_FLOW_API_TOKEN = 'secreto'
    const res = await appWith({ openWithoutToken: true }).request('/api/x', {
      headers: { authorization: 'Bearer secreto' },
    })
    expect(res.status).toBe(200)
  })

  // El token se lee POR REQUEST: `envRepo.loadIntoProcess()` corre después de
  // que los módulos se importan, así que capturarlo al construir el middleware
  // lo dejaría `undefined` para siempre.
  test('lee el token por request, no al construirse', async () => {
    const app = appWith({ openWithoutToken: true })
    expect((await app.request('/api/x')).status).toBe(200)

    process.env.IA_FLOW_API_TOKEN = 'llego-despues'
    expect((await app.request('/api/x')).status).toBe(401)
  })
})
