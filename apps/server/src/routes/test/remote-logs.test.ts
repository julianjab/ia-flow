import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createRemoteLogsRouter } from '../remote-logs.js'

const TOKEN = 'test-secret'

describe('POST /api/remote-logs', () => {
  const app = createRemoteLogsRouter()
  const originalToken = process.env.IA_FLOW_REMOTE_LOG_TOKEN

  beforeEach(() => {
    process.env.IA_FLOW_REMOTE_LOG_TOKEN = TOKEN
  })

  afterEach(() => {
    if (originalToken === undefined) delete process.env.IA_FLOW_REMOTE_LOG_TOKEN
    else process.env.IA_FLOW_REMOTE_LOG_TOKEN = originalToken
  })

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })

  test('rejects when no secret is configured (fail closed)', async () => {
    delete process.env.IA_FLOW_REMOTE_LOG_TOKEN
    const res = await post(
      { level: 'info', module: 'refiner-engine', msg: 'hello' },
      { 'x-ia-flow-token': TOKEN },
    )
    expect(res.status).toBe(503)
  })

  test('rejects a missing or wrong token', async () => {
    const noToken = await post({ level: 'info', module: 'refiner-engine', msg: 'hello' })
    expect(noToken.status).toBe(401)

    const wrongToken = await post(
      { level: 'info', module: 'refiner-engine', msg: 'hello' },
      { 'x-ia-flow-token': 'nope' },
    )
    expect(wrongToken.status).toBe(401)
  })

  test('accepts a well-formed entry with the right token', async () => {
    const res = await post(
      { level: 'info', module: 'refiner-engine', msg: 'hello' },
      { 'x-ia-flow-token': TOKEN },
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  test('accepts extras alongside msg', async () => {
    const res = await post(
      {
        level: 'warn',
        module: 'refiner-engine',
        msg: 'rate limited',
        extras: { runId: 'abc-123', attempt: 2 },
      },
      { 'x-ia-flow-token': TOKEN },
    )
    expect(res.status).toBe(200)
  })

  test('rejects oversized extras', async () => {
    const res = await post(
      {
        level: 'info',
        module: 'refiner-engine',
        msg: 'big',
        extras: { blob: 'x'.repeat(30_000) },
      },
      { 'x-ia-flow-token': TOKEN },
    )
    expect(res.status).toBe(413)
  })

  test('rejects an invalid level', async () => {
    const res = await post(
      { level: 'verbose', module: 'x', msg: 'y' },
      { 'x-ia-flow-token': TOKEN },
    )
    expect(res.status).toBe(400)
  })

  test('rejects malformed JSON', async () => {
    const res = await post('{not json', { 'x-ia-flow-token': TOKEN })
    expect(res.status).toBe(400)
  })
})
