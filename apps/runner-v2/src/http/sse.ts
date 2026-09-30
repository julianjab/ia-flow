/**
 * Server-Sent Events: la bandeja se entera en el momento de lo que cambia (`GET /api/stream`) y el
 * asistente streamea su respuesta (`POST /api/assistant`). Un evento por `data:` en JSON.
 */
import type { ServerResponse } from 'node:http'

/** Un ping cada tanto: un proxy corta una conexión sin tráfico. */
const KEEPALIVE_MS = 25_000

/** Abre la respuesta como stream de eventos. */
export function openSse(res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.write(': ok\n\n')
}

export function writeSse(res: ServerResponse, event: unknown): void {
  if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`)
}

/** Los que miran la bandeja ahora: cada cambio le llega a todos. */
export class SseHub<T> {
  private readonly clients = new Set<ServerResponse>()

  /** Deja abierta la respuesta hasta que el cliente se va. */
  attach(res: ServerResponse): void {
    openSse(res)
    this.clients.add(res)
    const ping = setInterval(() => res.write(': ping\n\n'), KEEPALIVE_MS)
    ping.unref()
    res.on('close', () => {
      clearInterval(ping)
      this.clients.delete(res)
    })
  }

  publish(event: T): void {
    for (const client of this.clients) writeSse(client, event)
  }

  get size(): number {
    return this.clients.size
  }

  close(): void {
    for (const client of this.clients) client.end()
    this.clients.clear()
  }
}
