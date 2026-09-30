import { afterEach, describe, expect, it } from 'bun:test'
import { createHmac } from 'node:crypto'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { MountedRunner } from '../boot.js'
import { deliveryScope, serve } from '../http/serve.js'

const repository = { full_name: 'la-haus/subscriptions' }

describe('deliveryScope', () => {
  it('tags a delivery with its id, repo and issue or PR, for the trace', () => {
    expect(
      deliveryScope({
        event: 'issue_comment',
        id: 'd-1',
        payload: { issue: { number: 7 }, repository },
      }),
    ).toEqual({
      source: 'webhook',
      deliveryId: 'd-1',
      repo: 'la-haus/subscriptions',
      issue: 'la-haus/subscriptions#7',
    })
    expect(
      deliveryScope({
        event: 'pull_request',
        payload: { pull_request: { number: 12 }, repository },
      }),
    ).toMatchObject({ issue: 'la-haus/subscriptions#12' })
  })

  it('leaves out what the payload does not bring', () => {
    expect(deliveryScope({ event: 'projects_v2_item', payload: {} })).toEqual({
      source: 'webhook',
    })
  })
})

describe('serve — despacho fallido', () => {
  let server: Server | undefined
  afterEach(async () => {
    server?.closeAllConnections()
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
    server = undefined
  })

  it('logs the cause of every pipeline that failed, not just the aggregate message', async () => {
    const lines: string[] = []
    const mounted = {
      projects: [],
      pipelines: () => [{ on: ['github.check_suite'] }],
      engine: {
        dispatch: async () => {
          throw new AggregateError([new Error('sin token de GitHub')], '1 pipeline(s) failed')
        },
      },
    } as unknown as MountedRunner
    server = await serve(mounted, { port: 0, secret: 's3cret', log: (line) => lines.push(line) })
    const { port } = server.address() as AddressInfo
    const body = JSON.stringify({ action: 'completed' })
    const res = await fetch(`http://127.0.0.1:${port}/api/webhooks/github`, {
      method: 'POST',
      body,
      headers: {
        'x-github-event': 'check_suite',
        'x-github-delivery': 'd-9',
        'x-hub-signature-256': `sha256=${createHmac('sha256', 's3cret').update(body).digest('hex')}`,
        'content-type': 'application/json',
      },
    })
    expect(res.status).toBe(202)
    for (let i = 0; i < 100 && !lines.some((l) => l.includes('el despacho falló')); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(lines.join('\n')).toContain(
      'check_suite.completed (d-9): el despacho falló: 1 pipeline(s) failed [errors[0]: Error: sin token de GitHub]',
    )
  })
})
