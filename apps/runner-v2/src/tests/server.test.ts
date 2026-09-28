import { afterEach, describe, expect, it, vi } from 'bun:test'
import { createHmac } from 'node:crypto'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Delivery } from '../server.js'
import { createWebhookServer } from '../server.js'

const SECRET = 'whsec_test'

/** Reintenta `check` hasta que no tire (o vence): lo que `vi.waitFor` hace en vitest. */
async function waitFor(check: () => unknown | Promise<unknown>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      await check()
      return
    } catch (error) {
      if (Date.now() > deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
}
let server: Server | undefined

afterEach(async () => {
  // `close` espera las conexiones abiertas: las keep-alive que dejó `fetch` se cierran a mano.
  server?.closeAllConnections()
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = undefined
})

async function start(secret: string | undefined, onDelivery = vi.fn(async (_d: Delivery) => {})) {
  server = createWebhookServer({ secret, onDelivery, status: () => ({ extra: 1 }), log: () => {} })
  await new Promise<void>((resolve) => server?.listen(0, resolve))
  const { port } = server.address() as AddressInfo
  return { base: `http://127.0.0.1:${port}`, onDelivery }
}

function post(base: string, body: string, headers: Record<string, string>) {
  return fetch(`${base}/api/webhooks/github`, { method: 'POST', body, headers })
}

function signed(body: string, event: string, delivery = 'd-1') {
  return {
    'x-github-event': event,
    'x-github-delivery': delivery,
    'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`,
    'content-type': 'application/json',
  }
}

describe('webhook server', () => {
  it('accepts a signed delivery with 202 and hands it over', async () => {
    const { base, onDelivery } = await start(SECRET)
    const body = JSON.stringify({ action: 'created', comment: { id: 1 } })
    const res = await post(base, body, signed(body, 'issue_comment'))
    expect(res.status).toBe(202)
    await waitFor(() => expect(onDelivery).toHaveBeenCalledTimes(1))
    expect(onDelivery).toHaveBeenCalledWith({
      event: 'issue_comment',
      id: 'd-1',
      payload: { action: 'created', comment: { id: 1 } },
    })
  })

  it('rejects a bad signature with 401 and never hands it over', async () => {
    const { base, onDelivery } = await start(SECRET)
    const body = JSON.stringify({ action: 'created' })
    const res = await post(base, body, {
      ...signed(body, 'issue_comment'),
      'x-hub-signature-256': 'sha256=00',
    })
    expect(res.status).toBe(401)
    expect(onDelivery).not.toHaveBeenCalled()
  })

  it('fails closed with 503 when no secret is configured', async () => {
    const { base, onDelivery } = await start(undefined)
    const body = '{}'
    const res = await post(base, body, signed(body, 'issue_comment'))
    expect(res.status).toBe(503)
    expect(onDelivery).not.toHaveBeenCalled()
  })

  it('answers ping without handing it over', async () => {
    const { base, onDelivery } = await start(SECRET)
    const body = JSON.stringify({ zen: 'hi' })
    const res = await post(base, body, signed(body, 'ping'))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ pong: true })
    expect(onDelivery).not.toHaveBeenCalled()
  })

  it('drops a retried delivery id, but lets it through again if handling failed', async () => {
    const onDelivery = vi.fn(async (_d: Delivery) => {})
    // Rechaza al llamarse (en Bun, `mockRejectedValueOnce` crea la promesa rechazada al registrarla).
    onDelivery.mockImplementationOnce(async () => {
      throw new Error('board caído')
    })
    const { base } = await start(SECRET, onDelivery)
    const body = JSON.stringify({ action: 'created' })

    expect((await post(base, body, signed(body, 'issue_comment', 'd-9'))).status).toBe(202)
    await waitFor(() => expect(onDelivery).toHaveBeenCalledTimes(1))
    // Falló: el mismo id vuelve a entrar (un "Redeliver" desde GitHub).
    await waitFor(async () => {
      expect((await post(base, body, signed(body, 'issue_comment', 'd-9'))).status).toBe(202)
    })
    await waitFor(() => expect(onDelivery).toHaveBeenCalledTimes(2))
    // Salió bien: ahora sí es un duplicado.
    const dup = await post(base, body, signed(body, 'issue_comment', 'd-9'))
    expect(dup.status).toBe(200)
    expect(await dup.json()).toMatchObject({ duplicate: true })
    expect(onDelivery).toHaveBeenCalledTimes(2)
  })

  it('rejects invalid JSON with 400', async () => {
    const { base } = await start(SECRET)
    const body = 'not json'
    expect((await post(base, body, signed(body, 'issue_comment'))).status).toBe(400)
  })

  it('serves the status endpoint and 404s the rest', async () => {
    const { base } = await start(SECRET)
    const status = await fetch(`${base}/api/webhooks/status`)
    expect(await status.json()).toEqual({
      endpoint: '/api/webhooks/github',
      secretConfigured: true,
      extra: 1,
    })
    expect((await fetch(`${base}/nope`)).status).toBe(404)
  })
})
