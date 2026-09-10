import type axios from 'axios'
import { describe, expect, it, vi } from 'vitest'
import { type AgentHostRegistration, removeRegistration } from '../api'

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
