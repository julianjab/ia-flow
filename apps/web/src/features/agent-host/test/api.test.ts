import type axios from 'axios'
import { describe, expect, it, vi } from 'vitest'
import {
  type AgentHostRegistration,
  fetchAgentHostLogs,
  fetchRuns,
  fetchSystemPrompt,
  removeRegistration,
  saveSystemPrompt,
} from '../api'

describe('removeRegistration', () => {
  it('manda el serverUrl como query — el agent-host lee `?serverUrl=`, no el body', async () => {
    const c = { delete: vi.fn().mockResolvedValue({ data: {} }) }

    await removeRegistration(
      c as unknown as ReturnType<typeof axios.create>,
      'http://localhost:3001',
    )

    expect(c.delete).toHaveBeenCalledWith('/v1/registrations', {
      params: { serverUrl: 'http://localhost:3001' },
    })
  })
})

describe('AgentHostRegistration', () => {
  it('nombra el motivo como el wire (`reason`), no `error`', () => {
    // El agent-host serializa `RegistrationOutcome` (apps/agent-host/src/app.ts).
    const wire = { serverUrl: 'http://localhost:3001', ok: false, reason: 'no se pudo alcanzar' }
    const reg: AgentHostRegistration = wire

    expect(reg.reason).toBe('no se pudo alcanzar')
  })
})

describe('fetchAgentHostLogs', () => {
  it('pide una ventana fija (200), sin importar el limit que mande el componente', async () => {
    const c = {
      get: vi.fn().mockResolvedValue({ data: { file: '/x.log', lines: [], truncated: false } }),
    }

    await fetchAgentHostLogs(c as unknown as ReturnType<typeof axios.create>, { limit: 50 })

    expect(c.get).toHaveBeenCalledWith('/v1/logs', { params: { q: '', limit: 200 } })
  })

  it('sin archivo configurado, tira en vez de devolver una lista vacía', async () => {
    const c = {
      get: vi.fn().mockResolvedValue({ data: { file: null, lines: [], truncated: false } }),
    }

    await expect(
      fetchAgentHostLogs(c as unknown as ReturnType<typeof axios.create>, {}),
    ).rejects.toThrow('sin archivo de log')
  })

  it('conserva una línea no-JSON (raw, sin time) en vez de descartarla', async () => {
    const c = {
      get: vi.fn().mockResolvedValue({
        data: {
          file: '/x.log',
          truncated: false,
          lines: [{ raw: 'boom: segfault' }],
        },
      }),
    }

    const { entries } = await fetchAgentHostLogs(
      c as unknown as ReturnType<typeof axios.create>,
      {},
    )

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ msg: 'boom: segfault', level: 'info' })
    expect(typeof entries[0]?.time).toBe('string')
  })

  it('el resumen por nivel es del set completo, no de lo ya filtrado por nivel', async () => {
    const c = {
      get: vi.fn().mockImplementation(async (_url: string, opts: { params: { q: string } }) => {
        // La primera llamada (sin nivel en `q`) trae de todo; la segunda
        // (con `error` en `q`) simula que el agent-host encontró más
        // errores buscando más atrás en el archivo.
        if (opts.params.q === '') {
          return {
            data: {
              file: '/x.log',
              truncated: false,
              lines: [
                { level: 30, time: '2026-01-01T00:00:00.000Z', msg: 'ok' },
                { level: 50, time: '2026-01-01T00:00:01.000Z', msg: 'boom' },
              ],
            },
          }
        }
        return {
          data: {
            file: '/x.log',
            truncated: false,
            lines: [
              { level: 50, time: '2026-01-01T00:00:01.000Z', msg: 'boom' },
              { level: 50, time: '2025-12-31T00:00:00.000Z', msg: 'boom viejo' },
            ],
          },
        }
      }),
    }

    const { entries, levelCounts } = await fetchAgentHostLogs(
      c as unknown as ReturnType<typeof axios.create>,
      { level: 'error' },
    )

    // Dos llamadas: una sin nivel (para el resumen) y una con `error` en `q`.
    expect(c.get).toHaveBeenCalledTimes(2)
    expect(c.get).toHaveBeenNthCalledWith(2, '/v1/logs', { params: { q: 'error', limit: 200 } })
    expect(levelCounts).toMatchObject({ info: 1, error: 1 })
    expect(entries.map((e) => e.msg)).toEqual(['boom', 'boom viejo'])
  })

  it('re-chequea el nivel con igualdad — matchLine matchea por substring y podría colar una línea "info"', async () => {
    const c = {
      get: vi.fn().mockResolvedValue({
        data: {
          file: '/x.log',
          truncated: false,
          lines: [
            { level: 30, time: '2026-01-01T00:00:00.000Z', msg: 'manejamos el error a propósito' },
            { level: 50, time: '2026-01-01T00:00:01.000Z', msg: 'boom' },
          ],
        },
      }),
    }

    const { entries } = await fetchAgentHostLogs(c as unknown as ReturnType<typeof axios.create>, {
      level: 'error',
    })

    expect(entries).toEqual([expect.objectContaining({ level: 'error', msg: 'boom' })])
  })
})

describe('fetchRuns', () => {
  it('pega a /v1/runs y devuelve running + runs tal cual', async () => {
    const wire = {
      running: 1,
      runs: [
        {
          taskId: 't1',
          agentId: 'reviewer',
          mode: 'inline',
          startedAt: '2026-09-11T00:00:00.000Z',
        },
      ],
    }
    const c = { get: vi.fn().mockResolvedValue({ data: wire }) }

    const result = await fetchRuns(c as unknown as ReturnType<typeof axios.create>)

    expect(c.get).toHaveBeenCalledWith('/v1/runs')
    expect(result).toEqual(wire)
  })
})

describe('fetchSystemPrompt / saveSystemPrompt', () => {
  it('fetch desenvuelve `blocks` de la respuesta', async () => {
    const c = {
      get: vi.fn().mockResolvedValue({ data: { blocks: [{ type: 'text', text: 'x' }] } }),
    }

    const blocks = await fetchSystemPrompt(c as unknown as ReturnType<typeof axios.create>)

    expect(c.get).toHaveBeenCalledWith('/v1/system-prompt')
    expect(blocks).toEqual([{ type: 'text', text: 'x' }])
  })

  it('save manda `{ blocks }` y devuelve lo guardado por el agent-host', async () => {
    const c = {
      put: vi.fn().mockResolvedValue({ data: { blocks: [{ type: 'text', text: 'nuevo' }] } }),
    }

    const blocks = await saveSystemPrompt(c as unknown as ReturnType<typeof axios.create>, [
      { type: 'text', text: 'nuevo' },
    ])

    expect(c.put).toHaveBeenCalledWith('/v1/system-prompt', {
      blocks: [{ type: 'text', text: 'nuevo' }],
    })
    expect(blocks).toEqual([{ type: 'text', text: 'nuevo' }])
  })
})
