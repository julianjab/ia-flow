/**
 * Resolución del puerto HTTP del daemon. `IA_FLOW_SERVER_PORT` es el nombre
 * canónico (pareja de `IA_FLOW_WEB_PORT`, que consume vite.config.ts); `PORT`
 * se mantiene como alias histórico para no romper despliegues existentes.
 */
export const DEFAULT_SERVER_PORT = 3001

type Env = Record<string, string | undefined>

export function resolveServerPort(env: Env = Bun.env): number {
  for (const key of ['IA_FLOW_SERVER_PORT', 'PORT']) {
    const raw = env[key]?.trim()
    if (!raw) continue
    const port = Number.parseInt(raw, 10)
    if (Number.isInteger(port) && port > 0 && port < 65536) return port
    throw new Error(`${key} inválido: "${raw}" — debe ser un entero entre 1 y 65535`)
  }
  return DEFAULT_SERVER_PORT
}

/** URL base del propio daemon, tal como la ven los agentes y las tools. */
export function daemonUrl(env: Env = Bun.env): string {
  return `http://localhost:${resolveServerPort(env)}`
}
