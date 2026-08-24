// Proxy hacia un provider expuesto por una instancia de
// apps/ai-provider-gateway registrada vía /api/provider-registrations.
// Implementa IAgentProvider igual que anthropic-api/tmux-claude/iterm-claude
// — el resto del engine (Agent.run, resolveProvider) no distingue un
// provider local de uno remoto.
//
// `id` se namespacea como `remote:<registrationId>` en vez de usar el
// `remoteProviderId` crudo (ej. "claude-print") para que registrar el mismo
// providerId dos veces (dos gateways distintos, o el mismo gateway con dos
// tokens) no colisione en el ProviderRegistry — cada registración es un
// provider elegible propio.
import type {
  Admission,
  AdmissionRequest,
  IAgentProvider,
  ProviderInput,
  ProviderKind,
  ProviderOutput,
} from '@ia-flow/ai-providers'
import { ADMIT, ProviderAtCapacityError, decline, withinDeclaredCap } from '@ia-flow/ai-providers'
import { EMPTY_WORKSPACE_PLAN } from '@ia-flow/shared'
import type { WorkspacePlan } from '@ia-flow/shared'
import type { ProviderRegistration } from '../../domain/ports/IProviderRegistrationRepository.js'

// La sonda corre en el camino caliente del dispatch (una por candidato):
// cortita a propósito, un gateway que tarda más que esto en decir si puede
// se trata como disponible y que decida el run.
const CAPACITY_PROBE_TIMEOUT_MS = 2_000

/** `Retry-After` en segundos (RFC 9110) → ms. Ignora la forma con fecha:
 *  hoy nadie la emite y no vale complicar el parseo por eso. */
function retryAfterMsFrom(res: Response): number | undefined {
  const raw = res.headers.get('retry-after')
  const secs = raw ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isFinite(secs) && secs >= 0 ? secs * 1_000 : undefined
}

export function remoteProviderId(registrationId: string): string {
  return `remote:${registrationId}`
}

export class RemoteAgentProvider implements IAgentProvider {
  readonly id: string
  readonly kind: ProviderKind
  readonly name: string
  readonly description: string

  constructor(private registration: ProviderRegistration) {
    this.id = remoteProviderId(registration.id)
    this.kind = registration.remoteKind
    this.name = `${registration.remoteName} (${registration.name})`
    this.description = registration.remoteDescription
  }

  /**
   * Le pregunta al gateway. Es el caso que justifica que la decisión sea del
   * provider y no del engine: el gateway corre en otro proceso, puede estar
   * registrado en varios daemons, y sabe cosas que este daemon no —
   * su RAM, si está ocupado con trabajo que no vino de acá.
   *
   * Primero el cap declarado (gratis, no sale del proceso) y recién después
   * la sonda de red. Fail-open en todo lo que no sea un "no" explícito: un
   * gateway viejo sin el endpoint (404), un timeout o un DNS caído admiten y
   * el run sigue el camino normal — donde un fallo real sí se reporta.
   */
  async canAccept(req: AdmissionRequest): Promise<Admission> {
    const declared = withinDeclaredCap(req)
    if (!declared.accept) return declared

    const { baseUrl, token } = this.registration
    try {
      const res = await fetch(`${baseUrl}/v1/capacity`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(CAPACITY_PROBE_TIMEOUT_MS),
      })
      if (!res.ok) return ADMIT
      const body = (await res.json()) as {
        accepting?: unknown
        reason?: unknown
        retryAfterMs?: unknown
      }
      if (body.accepting !== false) return ADMIT
      return decline(
        typeof body.reason === 'string' && body.reason
          ? `gateway: ${body.reason}`
          : 'el gateway no está aceptando trabajo',
        typeof body.retryAfterMs === 'number' ? body.retryAfterMs : undefined,
      )
    } catch {
      return ADMIT
    }
  }

  /**
   * No hay nada que preparar de este lado del cable: el terreno lo arma el
   * gateway, que es quien tiene el disco donde va a correr el agente. El
   * `WorkspaceRequest` viaja dentro del `ProviderInput` y allá se resuelve
   * (ver `resolveWorkspace` en apps/ai-provider-gateway/src/app.ts).
   *
   * Se implementa explícitamente —en vez de omitirlo— porque es justamente
   * el caso que motivó mover el workspace a los providers: antes el engine
   * calculaba paths de ESTA máquina y se los mandaba a la otra.
   */
  async prepareWorkspace(): Promise<WorkspacePlan> {
    return EMPTY_WORKSPACE_PLAN
  }

  async run(input: ProviderInput): Promise<ProviderOutput> {
    const { baseUrl, token } = this.registration
    // `input.policy.toolNames` is a Set (PolicyLike, packages/ai-providers/
    // src/contract.ts) — JSON.stringify silently drops a Set's contents
    // (it serializes to `{}`, not an array), so without this the remote
    // gateway receives an empty allow-list and its own `new Set({})`/spread
    // over that empty object throws ("Spread syntax requires
    // ...iterable[Symbol.iterator] to be a function"). Rebuild the body as
    // a plain array here so the gateway (packages/ai-providers/src/
    // anthropic-api/provider.ts) gets the real tool names back.
    const body = input.policy
      ? { ...input, policy: { ...input.policy, toolNames: [...input.policy.toolNames] } }
      : input
    const res = await fetch(`${baseUrl}/v1/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: input.signal,
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      // 503 = el gateway está al tope. Es la contracara de `canAccept`: la
      // sonda admitió y otro dispatch se comió el último slot en la ventana
      // entre sonda y run (es consultiva, no reserva). Tratarlo como error
      // dispararía el `onError` del agente — mover el issue de status y
      // comentar un fallo que no pasó. Se difiere en su lugar.
      if (res.status === 503) {
        throw new ProviderAtCapacityError(
          `RemoteAgentProvider(${this.id}): el gateway está al tope — ${body.slice(0, 200)}`,
          retryAfterMsFrom(res),
        )
      }
      throw new Error(
        `RemoteAgentProvider(${this.id}): ${baseUrl} respondió ${res.status} — ${body.slice(0, 500)}`,
      )
    }

    return (await res.json()) as ProviderOutput
  }
}
