/**
 * Resuelve `${SECRETO}` dentro de templates (`HttpAction.url`/`headers`/
 * `body`, `ScriptAction.env`) — el pipeline layer nunca lee `process.env`
 * ni ningún vault directo (ver "Efectos en los bordes" del CLAUDE.md de
 * este repo: el dominio no hace I/O, recibe un port). Un solo settable
 * módulo-nivel en vez de inyectar por constructor porque HttpAction/
 * ScriptAction se instancian desde config hidratada (YAML/DB), no desde un
 * composition root que las arme una por una — mismo patrón que
 * `setSecretResolver` en v1 (`packages/agent-engine`).
 */
export interface SecretResolver {
  resolve(name: string): Promise<string | undefined>
}

let current: SecretResolver | undefined

export function setSecretResolver(resolver: SecretResolver | undefined): void {
  current = resolver
}

export function getSecretResolver(): SecretResolver | undefined {
  return current
}
