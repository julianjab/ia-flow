import type { SystemPromptRef } from '@ia-flow/shared'

// Un provider registrado apunta a una instancia de apps/agent-host
// (dominio+puerto+credencial), que queda disponible como un provider más
// elegible por los agentes vía RemoteAgentProvider (adapters/remote-provider).
// Cuál provider concreto corre detrás de esa instancia es una decisión
// interna del agent-host — el server principal no la conoce ni la elige.
// remoteKind/remoteName/remoteDescription se capturan al registrar
// (GET /v1/provider del agent-host) — no se vuelven a pedir en cada boot.
//
// `systemPrompt` es un bloque ADICIONAL a los que ya arma el agente
// (Agent.ts → resolveSystemPromptBlocks) — no los reemplaza. Describe cómo
// correr específicamente en ESTE gateway (ej. "estás en una VM efímera sin
// red de salida"), así que aplica a cualquier agente que despache ahí, sin
// que cada AgentDefinition tenga que declararlo. Mismo `SystemPromptRef` que
// ya usan AgentDefinition/ProjectSettings (id del catálogo, o texto inline);
// se resuelve al despachar en RemoteAgentProvider.run(), nunca en el
// agent-host — mismo patrón que los secretos de MCP.
export interface ProviderRegistration {
  id: string
  name: string
  baseUrl: string
  token: string
  remoteKind: 'sync' | 'async'
  remoteName: string
  remoteDescription: string
  createdAt: string
  systemPrompt: SystemPromptRef | null
}

export interface IProviderRegistrationRepository {
  list(): ProviderRegistration[]
  get(id: string): ProviderRegistration | null
  insert(registration: ProviderRegistration): void
  deleteById(id: string): void
  updateSystemPrompt(id: string, systemPrompt: SystemPromptRef | null): void
}
