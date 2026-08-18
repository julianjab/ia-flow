import { describe, expect, test } from 'bun:test'
import { createRemoteLogsRouter } from '../remote-logs.js'

describe('POST /api/remote-logs', () => {
  const app = createRemoteLogsRouter()

  test('accepts a well-formed entry', async () => {
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ level: 'info', module: 'refiner-engine', msg: 'hello' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  test('accepts extras alongside msg', async () => {
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        level: 'warn',
        module: 'refiner-engine',
        msg: 'rate limited',
        extras: { runId: 'abc-123', attempt: 2 },
      }),
    })
    expect(res.status).toBe(200)
  })

  test('rejects an invalid level', async () => {
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ level: 'verbose', module: 'x', msg: 'y' }),
    })
    expect(res.status).toBe(400)
  })

  test('rejects malformed JSON', async () => {
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })
    expect(res.status).toBe(400)
  })
})
