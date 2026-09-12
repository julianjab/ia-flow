import type axios from 'axios'
import { describe, expect, it, vi } from 'vitest'
import {
  type AgentHostRegistration,
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
