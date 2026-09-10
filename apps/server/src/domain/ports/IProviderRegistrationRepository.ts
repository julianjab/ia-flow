// Un provider registrado apunta a una instancia de apps/agent-host
// (dominio+puerto+credencial), que queda disponible como un provider más
// elegible por los agentes vía RemoteAgentProvider (adapters/remote-provider).
// Cuál provider concreto corre detrás de esa instancia es una decisión
// interna del agent-host — el server principal no la conoce ni la elige.
// remoteKind/remoteName/remoteDescription se capturan al registrar
// (GET /v1/provider del agent-host) — no se vuelven a pedir en cada boot.
export interface ProviderRegistration {
  id: string
  name: string
  baseUrl: string
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
