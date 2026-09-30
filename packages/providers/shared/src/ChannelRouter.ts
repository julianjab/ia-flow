import { handleMcp } from './McpProtocol.js'
import type { RunChannel } from './RunChannel.js'

/** Lo que se contesta: `body: null` = sin cuerpo (una notificación MCP). */
export interface ChannelReply {
  status: number
  body: unknown
}

/**
 * Las corridas abiertas de un servidor, por su token, y cómo se contesta cada request — sin
 * transporte, así lo monta cualquiera: el servidor local del CLI (`127.0.0.1`, node http) y la API
 * del runner para los hosts remotos (fetch). Dos rutas por corrida:
 *
 *   mcp/<token>            el MCP de la corrida: las tools del agente (JSON-RPC)
 *   hooks/<token>/<Evento> un hook de Claude Code (traza, inbox, no terminar sin cerrar el turno)
 *
 * El token (al azar, uno por corrida) va en el path: la sesión lo manda sin headers, y muere con la
 * corrida.
 */
export class ChannelRouter {
  private readonly channels = new Map<string, RunChannel>()

  open(channel: RunChannel): void {
    this.channels.set(channel.token, channel)
  }

  close(channel: RunChannel): void {
    this.channels.delete(channel.token)
  }

  get(token: string): RunChannel | undefined {
    return this.channels.get(token)
  }

  /** `kind` es `mcp` o `hooks`; `event`, el del hook. */
  async handle(
    kind: string,
    token: string,
    event: string | undefined,
    body: unknown,
  ): Promise<ChannelReply> {
    const channel = this.channels.get(token)
    if (kind === 'hooks') {
      // Un hook nunca tiene que romper la sesión: sin corrida (ya cerró), no hay nada que decir.
      return { status: 200, body: channel ? channel.hook(event ?? '', asObject(body)) : {} }
    }
    if (kind !== 'mcp' || !channel) return { status: 404, body: { error: 'corrida desconocida' } }
    return handleMcp(channel, body)
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}
