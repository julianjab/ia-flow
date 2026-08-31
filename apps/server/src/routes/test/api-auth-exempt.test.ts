import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { createApiAuthMiddleware } from '../api-auth.js'

// Las rutas que traen su propia autenticación.
//
// El caso que motivó el test: `/api/webhooks/slack` no estaba en la lista, así
// que el guard mataba el delivery —503 sin `IA_FLOW_API_TOKEN`, 401 con él—
// antes de que corriera `verifySlackSignature`. Slack no puede mandar un
// `x-ia-flow-token`, y el síntoma era "Slack no dispara reglas" sin una línea
// en ningún log.
//
// La contracara es igual de importante: la lista es de rutas EXACTAS. Eximir
// `/api/webhooks` entero dejaría `GET /api/webhooks/status` —que devuelve
// proyectos, targets y si hay secreto— accesible desde adentro del cluster.

function app() {
  const a = new Hono()
  a.use('/api/*', createApiAuthMiddleware())
  a.all('/api/*', (c) => c.json({ ok: true }))
  return a
}

const original = process.env.IA_FLOW_API_TOKEN

beforeEach(() => {
  delete process.env.IA_FLOW_API_TOKEN
})
afterEach(() => {
  if (original === undefined) delete process.env.IA_FLOW_API_TOKEN
  else process.env.IA_FLOW_API_TOKEN = original
})

describe('rutas eximidas del guard', () => {
  for (const path of [
    '/api/webhooks/github',
    '/api/webhooks/slack',
    '/api/remote-logs',
    '/api/remote-executions',
  ]) {
    test(`${path} pasa sin token, porque valida la suya`, async () => {
      // Fail-closed y sin token: cualquier otra ruta daría 503.
      const res = await app().request(path, { method: 'POST' })
      expect(res.status).toBe(200)
    })

    test(`${path} sigue pasando con el token configurado`, async () => {
      process.env.IA_FLOW_API_TOKEN = 's3cr3t'
      const res = await app().request(path, { method: 'POST' })
      expect(res.status).toBe(200)
    })
  }

  test('el status de webhooks NO se exime: la lista es de rutas exactas', async () => {
    process.env.IA_FLOW_API_TOKEN = 's3cr3t'
    const res = await app().request('/api/webhooks/status')
    expect(res.status).toBe(401)
  })
})
