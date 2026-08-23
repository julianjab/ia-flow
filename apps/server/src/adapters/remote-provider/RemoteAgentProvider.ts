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
  IAgentProvider,
  ProviderInput,
  ProviderKind,
  ProviderOutput,
} from '@ia-flow/ai-providers'
import type { ProviderRegistration } from '../../domain/ports/IProviderRegistrationRepository.js'

// La sonda corre en el camino caliente del dispatch (una por candidato):
// cortita a propósito, un gateway que tarda más que esto en decir si puede
// se trata como disponible y que decida el run.
const CAPACITY_PROBE_TIMEOUT_MS = 2_000

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
   * Sonda a `GET /v1/capacity` del gateway (ver apps/ai-provider-gateway).
   * Fail-open en todo lo que no sea un "no" explícito: un gateway viejo sin
   * el endpoint (404), un timeout o un DNS caído devuelven `true` y el run
   * sigue el camino normal — donde un fallo real ya se reporta como error.
   * Congelar el dispatch por una sonda rota sería peor que intentarlo.
   */
  async canAccept(): Promise<boolean> {
    const { baseUrl, token } = this.registration
    try {
      const res = await fetch(`${baseUrl}/v1/capacity`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(CAPACITY_PROBE_TIMEOUT_MS),
      })
      if (!res.ok) return true
      const body = (await res.json()) as { accepting?: unknown }
      return body.accepting !== false
    } catch {
      return true
    }
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
      throw new Error(
        `RemoteAgentProvider(${this.id}): ${baseUrl} respondió ${res.status} — ${body.slice(0, 500)}`,
      )
    }

    return (await res.json()) as ProviderOutput
  }
}
