import type { DevicePoll } from '@ia-flow/shared'
import { describe, expect, it, vi } from 'vitest'
import { type PollOptions, pollUntilDone, SLOW_DOWN_STEP_S } from '../deviceFlow'

/** Un reloj que avanza sólo cuando se "duerme": los tests no esperan de verdad. */
function harness(replies: (DevicePoll | Error)[], over: Partial<PollOptions> = {}) {
  let clock = 0
  const slept: number[] = []
  const queue = [...replies]
  const poll = vi.fn(async () => {
    const next = queue.shift()
    if (!next) throw new Error('sin más respuestas')
    if (next instanceof Error) throw next
    return next
  })
  const opts: PollOptions = {
    deviceCode: 'dc',
    interval: 5,
    expiresIn: 900,
    poll,
    sleep: async (ms) => {
      slept.push(ms)
      clock += ms
    },
    now: () => clock,
    ...over,
  }
  return { opts, poll, slept }
}

describe('pollUntilDone', () => {
  it('sigue mientras esté pending y termina con el token al autorizar', async () => {
    const { opts, poll } = harness([
      { status: 'pending' },
      { status: 'pending' },
      { status: 'ok', access_token: 'gho_1', login: 'ada' },
    ])
    expect(await pollUntilDone(opts)).toEqual({ status: 'ok', token: 'gho_1', login: 'ada' })
    expect(poll).toHaveBeenCalledTimes(3)
    expect(poll).toHaveBeenCalledWith('dc')
  })

  it('un token que vence trae con qué renovarlo', async () => {
    const renewal = { expires_in: 28_800, refresh_token: 'ghr_1', refresh_token_expires_in: 99 }
    const { opts } = harness([{ status: 'ok', access_token: 'ghu_1', login: 'ada', ...renewal }])
    expect(await pollUntilDone(opts)).toEqual({
      status: 'ok',
      token: 'ghu_1',
      login: 'ada',
      ...renewal,
    })
  })

  it('slow_down suma 5 s al intervalo y lo avisa', async () => {
    const seen: number[] = []
    const { opts, slept } = harness(
      [
        { status: 'slow_down' },
        { status: 'slow_down' },
        { status: 'ok', access_token: 't', login: 'l' },
      ],
      { onInterval: (s) => seen.push(s) },
    )
    await pollUntilDone(opts)
    expect(slept).toEqual([
      5000,
      5000 + SLOW_DOWN_STEP_S * 1000,
      5000 + 2 * SLOW_DOWN_STEP_S * 1000,
    ])
    expect(seen).toEqual([10, 15])
  })

  it.each(['denied', 'expired'] as const)('%s termina sin reintentar', async (status) => {
    const { opts, poll } = harness([{ status }])
    expect(await pollUntilDone(opts)).toEqual({ status })
    expect(poll).toHaveBeenCalledTimes(1)
  })

  it('vence por reloj aunque GitHub nunca conteste expired', async () => {
    const { opts } = harness(
      Array.from({ length: 50 }, () => ({ status: 'pending' as const })),
      {
        expiresIn: 12,
      },
    )
    expect(await pollUntilDone(opts)).toEqual({ status: 'expired' })
  })

  it('tolera tres fallas de red seguidas y reporta la cuarta', async () => {
    const boom = new Error('red caída')
    const tolerated = harness([boom, boom, boom, { status: 'ok', access_token: 't', login: 'l' }])
    expect((await pollUntilDone(tolerated.opts)).status).toBe('ok')

    const dead = harness([boom, boom, boom, boom])
    expect(await pollUntilDone(dead.opts)).toEqual({ status: 'error', message: 'red caída' })
  })

  it('un ok sin token o sin login no es un login', async () => {
    const { opts } = harness([{ status: 'ok', login: 'ada' }])
    expect((await pollUntilDone(opts)).status).toBe('error')
  })

  it('cancelar corta antes de sondear', async () => {
    const ctl = new AbortController()
    ctl.abort()
    const { opts, poll } = harness([{ status: 'pending' }], { signal: ctl.signal })
    expect(await pollUntilDone(opts)).toEqual({ status: 'cancelled' })
    expect(poll).not.toHaveBeenCalled()
  })
})
