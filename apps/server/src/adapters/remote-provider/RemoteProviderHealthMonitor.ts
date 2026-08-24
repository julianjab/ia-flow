import type { RemoteProviderHealth } from '@ia-flow/shared'
// Mantiene el ProviderRegistry sincronizado con la salud real de los
// gateways remotos: un `remote:<name>` **existe** en el registry mientras su
// gateway conteste, y desaparece apenas deja de contestar.
//
// Por qué desregistrar en vez de dejarlo registrado con un flag: "disponible"
// en este sistema significa "está en el registry" — es lo que mira
// `GET /api/providers` (la lista que ofrece el editor de agentes) y lo que
// resuelve `AgentOrchestrator` al despachar. Un provider marcado pero
// presente obliga a cada consumidor a acordarse de filtrar; uno ausente lo
// hace imposible de elegir por construcción. El registro de la registración
// (la fila en SQLite) NO se toca: sigue listado en
// `GET /api/provider-registrations` con su health, que es donde el operador
// ve *por qué* desapareció.
//
// La sonda es `GET /v1/provider` — el mismo endpoint que valida el alta, así
// que un gateway ya registrado no necesita exponer nada nuevo. Cubre las tres
// formas de estar caído que importan: proceso muerto (red), token rotado
// (401) y proceso vivo pero roto (5xx).
import type { IAgentProvider } from '../../domain/ports/IAgentProvider.js'
import type { IBroadcast } from '../../domain/ports/IBroadcast.js'
import type {
  IProviderRegistrationRepository,
  ProviderRegistration,
} from '../../domain/ports/IProviderRegistrationRepository.js'
import { createLogger } from '../../logger.js'
import { RemoteAgentProvider, remoteProviderId } from './RemoteAgentProvider.js'
import { type ProbeResult, UNKNOWN_HEALTH, applyProbe, isAvailable } from './health.js'

const log = createLogger('remote-health')

/** Un número de ms de env, o `undefined` si no está seteado o no es válido —
 *  así el default manda. Se lee en cada uso, no al importar el módulo:
 *  `envRepo.loadIntoProcess()` corre después de los imports. */
function envMs(name: string): number | undefined {
  const n = Number(Bun.env[name])
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/** Lo que el monitor necesita del registry: dar de alta y de baja. Angosto a
 *  propósito — no es `IProviderRegistry` porque `unregister` no forma parte
 *  de ese port (el resto del engine nunca desregistra nada). */
export interface ProviderSlots {
  register(provider: IAgentProvider): void
  unregister(id: string): void
}

export interface RemoteProviderHealthMonitorOptions {
  /** Cada cuánto se sondean todos los remotos. Sin valor:
   *  `IA_FLOW_REMOTE_HEALTH_INTERVAL_MS`, o el default. */
  intervalMs?: number
  /** Corte de la sonda individual. Sin valor:
   *  `IA_FLOW_REMOTE_HEALTH_TIMEOUT_MS`, o el default. */
  timeoutMs?: number
  /** Inyectable para los tests — default: `fetch` con timeout. */
  probe?: (registration: ProviderRegistration) => Promise<ProbeResult>
  /** Inyectable para los tests — default: `new Date().toISOString()`. */
  now?: () => string
}

export const DEFAULT_HEALTH_INTERVAL_MS = 30_000
export const DEFAULT_HEALTH_TIMEOUT_MS = 3_000

export class RemoteProviderHealthMonitor {
  private health = new Map<string, RemoteProviderHealth>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private readonly probe: (registration: ProviderRegistration) => Promise<ProbeResult>
  private readonly now: () => string

  constructor(
    private readonly repo: IProviderRegistrationRepository,
    private readonly registry: ProviderSlots,
    private readonly broadcast: IBroadcast,
    private readonly options: RemoteProviderHealthMonitorOptions = {},
  ) {
    this.probe = options.probe ?? ((r) => this.httpProbe(r))
    this.now = options.now ?? (() => new Date().toISOString())
  }

  /** Health conocido de una registración. `unknown` mientras no se sondeó. */
  get(id: string): RemoteProviderHealth {
    return this.health.get(id) ?? UNKNOWN_HEALTH
  }

  /** Siembra el health de una registración recién creada: el alta ya sondeó
   *  el gateway (`fetchGatewayProvider`), volver a preguntarle acto seguido
   *  sería pura latencia. */
  markHealthy(id: string): void {
    this.health.set(id, { status: 'ok', checkedAt: this.now(), consecutiveFailures: 0 })
  }

  /** Olvida una registración borrada, para que su health no quede colgado. */
  forget(id: string): void {
    this.health.delete(id)
  }

  /**
   * Arranca el ciclo. La primera ronda corre ya —sin esperar un intervalo—
   * para que al bootear los remotos vivos queden disponibles enseguida.
   *
   * Se re-agenda con `setTimeout` en vez de un `setInterval` fijo para poder
   * releer el intervalo en cada vuelta: los env vars guardados en la DB
   * llegan a `process.env` recién con `envRepo.loadIntoProcess()`, y
   * cambiarlos desde la UI aplica desde la ronda siguiente sin reiniciar.
   * De paso, una ronda lenta no se solapa con la próxima.
   */
  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    await this.checkAll()
    this.scheduleNext()
  }

  stop(): void {
    this.running = false
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = null
  }

  private scheduleNext(): void {
    if (!this.running) return
    this.timer = setTimeout(() => {
      void this.checkAll().finally(() => this.scheduleNext())
    }, this.intervalMs())
    // No mantener vivo el proceso por el timer del health.
    this.timer.unref?.()
  }

  private intervalMs(): number {
    return (
      this.options.intervalMs ??
      envMs('IA_FLOW_REMOTE_HEALTH_INTERVAL_MS') ??
      DEFAULT_HEALTH_INTERVAL_MS
    )
  }

  private timeoutMs(): number {
    return (
      this.options.timeoutMs ??
      envMs('IA_FLOW_REMOTE_HEALTH_TIMEOUT_MS') ??
      DEFAULT_HEALTH_TIMEOUT_MS
    )
  }

  /** Sondea todas las registraciones y sincroniza el registry con el
   *  resultado. Se relee el repo en cada ronda: un alta o una baja hecha
   *  desde la UI entra sola en el próximo ciclo. */
  async checkAll(): Promise<void> {
    const registrations = this.repo.list()
    const live = new Set(registrations.map((r) => r.id))
    for (const id of [...this.health.keys()]) {
      if (!live.has(id)) this.health.delete(id)
    }
    await Promise.all(registrations.map((r) => this.checkOne(r)))
  }

  /** Sondea una registración y aplica el resultado (registry + broadcast). */
  async checkOne(registration: ProviderRegistration): Promise<RemoteProviderHealth> {
    const previous = this.get(registration.id)
    const result = await this.probe(registration)
    const health = applyProbe(previous, result, this.now())
    this.health.set(registration.id, health)
    this.sync(registration, previous, health)
    return health
  }

  /** Registra o desregistra según el health, y avisa sólo cuando CAMBIA —
   *  un gateway caído no debe inundar el log ni el WS cada 30s. */
  private sync(
    registration: ProviderRegistration,
    previous: RemoteProviderHealth,
    health: RemoteProviderHealth,
  ): void {
    const id = remoteProviderId(registration.id)
    if (isAvailable(health)) {
      // Re-registra con la registración fresca del repo (baseUrl o token
      // pudieron cambiar entre rondas), no con la instancia vieja.
      this.registry.register(new RemoteAgentProvider(registration))
    } else {
      this.registry.unregister(id)
    }
    if (previous.status === health.status) return
    if (isAvailable(health)) {
      log.info({ provider: id, latencyMs: health.latencyMs }, 'Provider remoto disponible')
    } else {
      log.warn({ provider: id, err: health.error }, 'Provider remoto caído — desregistrado')
    }
    this.broadcast.send({ type: 'provider-health', id: registration.id, provider: id, health })
  }

  private async httpProbe(registration: ProviderRegistration): Promise<ProbeResult> {
    const startedAt = performance.now()
    try {
      const res = await fetch(`${registration.baseUrl}/v1/provider`, {
        headers: { authorization: `Bearer ${registration.token}` },
        signal: AbortSignal.timeout(this.timeoutMs()),
      })
      if (!res.ok) return { ok: false, error: `${registration.baseUrl} respondió ${res.status}` }
      return { ok: true, latencyMs: performance.now() - startedAt }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }
}
