import { describe, expect, it } from 'bun:test'
import type {
  IProviderRegistrationRepository,
  ProviderRegistration,
} from '../../../domain/ports/IProviderRegistrationRepository.js'
import { remoteProviderId } from '../RemoteAgentProvider.js'
import { RemoteProviderHealthMonitor } from '../RemoteProviderHealthMonitor.js'
import type { ProbeResult } from '../health.js'

function registration(overrides: Partial<ProviderRegistration> = {}): ProviderRegistration {
  return {
    id: 'mac',
    name: 'mac',
    baseUrl: 'http://localhost:3002',
    token: 'secret',
    remoteKind: 'sync',
    remoteName: 'Claude Print',
    remoteDescription: 'invoca claude -p',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

/** Repo en memoria — el monitor sólo lista y busca por id. */
function fakeRepo(rows: ProviderRegistration[]): IProviderRegistrationRepository {
  return {
    list: () => rows,
    get: (id) => rows.find((r) => r.id === id) ?? null,
    insert: () => {},
    deleteById: () => {},
  }
}

function fakeRegistry() {
  const ids = new Set<string>()
  return {
    ids,
    register: (p: { id: string }) => {
      ids.add(p.id)
    },
    unregister: (id: string) => {
      ids.delete(id)
    },
  }
}

function makeMonitor(rows: ProviderRegistration[], probe: () => Promise<ProbeResult>) {
  const registry = fakeRegistry()
  const sent: object[] = []
  const monitor = new RemoteProviderHealthMonitor(
    fakeRepo(rows),
    registry,
    { send: (msg) => sent.push(msg) },
    { probe, now: () => '2026-01-01T00:00:05Z' },
  )
  return { monitor, registry, sent }
}

describe('RemoteProviderHealthMonitor', () => {
  it('registra el provider cuando el agent-host contesta', async () => {
    const { monitor, registry } = makeMonitor([registration()], async () => ({
      ok: true,
      latencyMs: 5,
    }))

    await monitor.checkAll()

    expect([...registry.ids]).toEqual([remoteProviderId('mac')])
    expect(monitor.get('mac').status).toBe('ok')
  })

  it('lo desregistra apenas deja de contestar — deja de ser elegible', async () => {
    let alive = true
    const { monitor, registry } = makeMonitor([registration()], async () =>
      alive ? { ok: true, latencyMs: 5 } : { ok: false, error: 'ECONNREFUSED' },
    )

    await monitor.checkAll()
    expect(registry.ids.has(remoteProviderId('mac'))).toBe(true)

    alive = false
    await monitor.checkAll()

    expect(registry.ids.has(remoteProviderId('mac'))).toBe(false)
    expect(monitor.get('mac')).toMatchObject({ status: 'down', error: 'ECONNREFUSED' })
  })

  it('lo vuelve a registrar cuando el agent-host revive', async () => {
    let alive = false
    const { monitor, registry } = makeMonitor([registration()], async () =>
      alive ? { ok: true, latencyMs: 5 } : { ok: false, error: 'timeout' },
    )

    await monitor.checkAll()
    expect(registry.ids.size).toBe(0)

    alive = true
    await monitor.checkAll()

    expect(registry.ids.has(remoteProviderId('mac'))).toBe(true)
  })

  it('avisa por broadcast sólo cuando el estado CAMBIA', async () => {
    const { monitor, sent } = makeMonitor([registration()], async () => ({
      ok: false,
      error: 'timeout',
    }))

    await monitor.checkAll()
    await monitor.checkAll()
    await monitor.checkAll()

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ type: 'provider-health', id: 'mac' })
  })

  it('nunca registra un remoto sin sondear — `unknown` no es disponible', () => {
    const { monitor, registry } = makeMonitor([registration()], async () => ({
      ok: true,
      latencyMs: 1,
    }))

    expect(monitor.get('mac').status).toBe('unknown')
    expect(registry.ids.size).toBe(0)
  })

  it('olvida el health de una registración borrada del repo', async () => {
    const rows = [registration()]
    const registry = fakeRegistry()
    const monitor = new RemoteProviderHealthMonitor(
      fakeRepo(rows),
      registry,
      { send: () => {} },
      { probe: async () => ({ ok: true, latencyMs: 1 }), now: () => '2026-01-01T00:00:05Z' },
    )

    await monitor.checkAll()
    expect(monitor.get('mac').status).toBe('ok')

    rows.length = 0
    await monitor.checkAll()

    expect(monitor.get('mac').status).toBe('unknown')
  })

  it('una registración borrada a mitad de sonda no queda registrada', async () => {
    // La ronda ya tomó su lista y la sonda tarda; en esa ventana el operador
    // borra la registración. Sin releer el repo, el resultado de la sonda la
    // dejaría registrada para siempre: las rondas siguientes ya no la ven.
    const rows = [registration()]
    const registry = fakeRegistry()
    const monitor = new RemoteProviderHealthMonitor(
      fakeRepo(rows),
      registry,
      { send: () => {} },
      {
        probe: async () => {
          rows.length = 0
          return { ok: true, latencyMs: 1 }
        },
        now: () => '2026-01-01T00:00:05Z',
      },
    )

    await monitor.checkAll()

    expect(registry.ids.size).toBe(0)
    expect(monitor.get('mac').status).toBe('unknown')
  })

  it('markHealthy siembra el alta recién creada, que ya fue sondeada por la ruta', () => {
    const { monitor } = makeMonitor([registration()], async () => ({ ok: false, error: 'x' }))

    monitor.markHealthy('mac')

    expect(monitor.get('mac')).toMatchObject({ status: 'ok', consecutiveFailures: 0 })
  })
})
