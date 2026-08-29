// Decisiones puras de `POST /api/remote-logs`, separadas de la ruta por lo
// mismo que `provider-registrations-logic.ts`: la ruta importa el container
// (repos, SQLite) y esto no importa nada, así que la parte que decide QUIÉN
// puede escribir en el log del daemon se testea sin levantar una base.
import { timingSafeEqual } from 'crypto'

/** Quién presentó el token. `agent-host` trae el id de la registración, que es lo
 *  que la ruta estampa en la línea. */
export type Caller = { source: 'upstream' } | { source: 'agent-host'; id: string }

/** Lo mínimo que `resolveCaller` necesita de una registración — declarado acá
 *  para no arrastrar el port entero a un módulo puro. */
export interface TokenHolder {
  id: string
  token?: string
}

export function secretEquals(provided: string | undefined, secret: string): boolean {
  if (!provided) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(secret)
  // La comparación timing-safe exige el mismo largo; salir antes filtra el
  // largo del secreto, que no es lo que protege este endpoint (escribir una
  // línea de log), y es lo que ya hacía la versión previa.
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Dos credenciales válidas, por dos emisores distintos:
 *
 *  - **el secreto global** (`IA_FLOW_REMOTE_LOG_TOKEN`) — un daemon headless
 *    reenviando su `daemon.log` al server principal (`upstream` del
 *    runner.yaml). Es como funcionaba esto desde siempre.
 *  - **el token de una registración de agentHost** — el mismo
 *    `API_AI_PROVIDER_TOKEN` que ese agentHost entregó al darse de alta. No hace
 *    falta un secreto nuevo ni mandarlo en cada run: el daemon ya lo guardó Y
 *    ya lo verificó (llamó al agentHost con él antes de insertar la fila), así
 *    que presentarlo de vuelta prueba identidad.
 *
 * La diferencia que importa es la **atribución**. Con el secreto global,
 * cualquiera que lo tenga puede decir que es cualquiera; acá el token resuelve
 * a UNA registración, y por eso la ruta puede estampar el `agent-host` de la línea
 * en vez de creerle al payload.
 *
 * El scan lineal es deliberado: las registraciones son un puñado, y un índice
 * por token obligaría a indexar un secreto en SQLite. La comparación sigue
 * siendo timing-safe fila por fila.
 */
export function resolveCaller(
  provided: string | undefined,
  globalSecret: string | undefined,
  holders: TokenHolder[],
): Caller | null {
  if (!provided) return null
  if (globalSecret && secretEquals(provided, globalSecret)) return { source: 'upstream' }
  for (const holder of holders) {
    if (holder.token && secretEquals(provided, holder.token)) {
      return { source: 'agent-host', id: holder.id }
    }
  }
  return null
}

/**
 * La atribución la pone el SERVIDOR, después de resolver el token. El spread
 * va último a propósito: si el payload traía su propio `agent-host`, éste lo pisa
 * — el emisor no elige con qué nombre aparece.
 */
export function attribute(
  extras: Record<string, unknown> | undefined,
  caller: Caller,
): Record<string, unknown> | undefined {
  if (caller.source !== 'agent-host') return extras
  return { ...(extras ?? {}), agentHost: caller.id }
}
