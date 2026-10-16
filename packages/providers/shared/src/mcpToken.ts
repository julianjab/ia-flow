/**
 * El bearer de un MCP externo (`McpServerRef.config.authorizationToken`): un string fijo o una
 * función que lo resuelve en el momento. Con `force`, el que tenía lo rechazó el servidor (un
 * installation token de GitHub vence a la hora): la función descarta su caché y pide otro.
 */
export type McpTokenSource = string | ((options?: { force?: boolean }) => string | Promise<string>)

/** El token de `raw` (un `McpTokenSource` o nada), o `undefined` si no hay ninguno. */
export async function resolveMcpToken(raw: unknown, force = false): Promise<string | undefined> {
  const value = typeof raw === 'function' ? await raw({ force }) : raw
  return typeof value === 'string' && value ? value : undefined
}
