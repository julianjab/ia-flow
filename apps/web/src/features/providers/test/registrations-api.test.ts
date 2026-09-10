import axios from 'axios'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { listProviderRegistrations } from '../registrations-api'

describe('listProviderRegistrations', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('un server sin monitor de salud no rompe la lista', async () => {
    // Desde que la web elige contra qué server mirar, apuntar a un build
    // anterior dejó de ser hipotético: ese server no manda `health`, y sin
    // normalizarlo el render explotaba con "reading 'status' of undefined" y
    // la sección quedaba colgada en "Cargando…".
    vi.spyOn(axios, 'get').mockResolvedValue({
      data: { registrations: [{ id: 'a', name: 'a', baseUrl: 'http://x', hasToken: true }] },
    })

    const [reg] = await listProviderRegistrations()

    expect(reg?.health).toEqual({ status: 'unknown', consecutiveFailures: 0 })
  })

  it('respeta el health que sí viene', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue({
      data: {
        registrations: [
          {
            id: 'a',
            name: 'a',
            baseUrl: 'http://x',
            hasToken: true,
            health: { status: 'ok', consecutiveFailures: 0, latencyMs: 12 },
          },
        ],
      },
    })

    const [reg] = await listProviderRegistrations()

    expect(reg?.health.status).toBe('ok')
    expect(reg?.health.latencyMs).toBe(12)
  })
})
