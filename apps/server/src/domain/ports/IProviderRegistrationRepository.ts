// Un provider registrado apunta a una instancia de apps/ai-provider-gateway
// (dominio+puerto+credencial) y a cuál de sus providers queda disponible
// como un provider más elegible por los agentes vía RemoteAgentProvider
// (adapters/remote-provider). remoteKind/remoteName/remoteDescription se
// capturan al registrar (GET /v1/providers del gateway) — no se vuelven a
// pedir en cada boot.
export interface ProviderRegistration {
  id: string
  name: string
  baseUrl: string
  remoteProviderId: string
  token: string
  remoteKind: 'sync' | 'async'
  remoteName: string
  remoteDescription: string
  createdAt: string
}

export interface IProviderRegistrationRepository {
  list(): ProviderRegistration[]
  get(id: string): ProviderRegistration | null
  insert(registration: ProviderRegistration): void
  deleteById(id: string): void
}
