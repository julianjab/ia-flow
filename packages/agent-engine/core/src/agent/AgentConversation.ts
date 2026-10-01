/**
 * La conversación que guarda un agente (al esperar un evento, o su progreso para un reinicio),
 * marcada con el provider que la armó: es opaca y sólo ese provider sabe retomarla.
 */
export interface AgentConversation {
  provider: string
  conversation: unknown
}

export function wrapConversation(provider: string, conversation: unknown): AgentConversation {
  return { provider, conversation }
}

/** La conversación guardada, y su provider si la guardó un agente que ya lo marcaba (una
 *  guardada antes, sin marca, se retoma con el provider que toque). */
export function unwrapConversation(state: unknown): { provider?: string; conversation: unknown } {
  if (typeof state === 'object' && state !== null && 'conversation' in state) {
    const provider = (state as { provider?: unknown }).provider
    if (typeof provider === 'string') {
      return { provider, conversation: (state as AgentConversation).conversation }
    }
  }
  return { conversation: state }
}
