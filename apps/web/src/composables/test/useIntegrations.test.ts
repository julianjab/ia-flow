import axios from 'axios'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetIntegrations, useIntegrations } from '../useIntegrations'

vi.mock('axios', () => ({ default: { get: vi.fn() } }))

const get = vi.mocked(axios.get)

beforeEach(() => {
  resetIntegrations()
  get.mockReset()
})

describe('useIntegrations', () => {
  it('publica lo que declara el server', async () => {
    get.mockResolvedValue({
      data: {
        slack: { enabled: false, webhook: false, reason: 'SLACK_BOT_TOKEN no está configurado' },
      },
    })

    const { integrations } = useIntegrations()
    await vi.waitFor(() => expect(integrations.value.slack.enabled).toBe(false))
    expect(integrations.value.slack.reason).toContain('SLACK_BOT_TOKEN')
  })

  it('falla OPEN: un server sin el endpoint deja la UI como estaba', async () => {
    get.mockRejectedValue(new Error('404'))

    const { integrations } = useIntegrations()
    expect(integrations.value.slack.enabled).toBe(true)
    await vi.waitFor(() => expect(get).toHaveBeenCalled())
    expect(integrations.value.slack.enabled).toBe(true)
  })

  it('pregunta una sola vez aunque la usen varios componentes', async () => {
    get.mockResolvedValue({ data: { slack: { enabled: true, webhook: true } } })

    useIntegrations()
    useIntegrations()
    useIntegrations()
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1))
  })
})
