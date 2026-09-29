/**
 * El catálogo MCP que los agentes nombran por id (`mcpServers: [github-mcp]`): cada servidor de
 * `runner.yaml` con sus `${VAR}` resueltos y probado. `${GITHUB_TOKEN}` es SIEMPRE el installation
 * token de la App (nunca del env); el resto sale de `process.env`.
 */
import type { McpServerRef } from '@ia-tools/agent-engine'
import type { GithubAuth } from '@ia-tools/github-auth'
import type { McpEntry } from '../config/RunnerConfig.js'

async function interpolate(value: string, resolveSecret: (name: string) => Promise<string>) {
  let out = value
  for (const match of value.matchAll(/\$\{([A-Z0-9_]+)\}/g)) {
    out = out.replace(match[0], await resolveSecret(match[1] as string))
  }
  return out
}

/**
 * ¿El MCP contesta? Anthropic rechaza la request ENTERA (400) si un `mcp_servers` no responde, así
 * que uno caído tumbaría a todos los agentes que lo usan. Cualquier respuesta < 500 cuenta como
 * vivo: un 401 o 405 a un `initialize` sin auth igual prueba que hay un server del otro lado.
 */
async function probeMcp(url: string, authorizationToken?: string): Promise<string | undefined> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(authorizationToken ? { authorization: `Bearer ${authorizationToken}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'ia-flow-runner-v2', version: '0' },
        },
      }),
      signal: AbortSignal.timeout(10_000),
    })
    await res.body?.cancel()
    return res.status >= 500 ? `HTTP ${res.status}` : undefined
  } catch (err) {
    return (err as Error).message
  }
}

/** Los servidores que responden, por id. Uno caído o sin su secreto queda en `warnings` y fuera
 *  del catálogo: el agente que lo nombra corre sin él. */
export async function resolveMcpCatalog(
  entries: McpEntry[],
  auth: GithubAuth,
  warnings: string[],
): Promise<Record<string, McpServerRef>> {
  const resolveSecret = async (name: string) => {
    if (name === 'GITHUB_TOKEN') return auth.getToken()
    const value = process.env[name]
    if (value == null || value === '') throw new Error(`falta la env var "${name}"`)
    return value
  }
  const catalog: Record<string, McpServerRef> = {}
  for (const entry of entries) {
    if (entry.config.type !== 'http' || !entry.config.url) {
      warnings.push(`mcp "${entry.id}": type ${entry.config.type} no se conecta desde este runner`)
      continue
    }
    try {
      const url = await interpolate(entry.config.url, resolveSecret)
      const tokenTemplate = entry.config.authorizationToken
      const token = tokenTemplate ? await interpolate(tokenTemplate, resolveSecret) : undefined
      const down = await probeMcp(url, token)
      if (down) {
        warnings.push(`mcp "${entry.id}" no responde (${down}) — los agentes corren sin él`)
        continue
      }
      // El token se vuelve a resolver en cada request (el provider acepta una función): el
      // installation token de GITHUB_TOKEN vence a la hora, y el servidor vive más que eso.
      catalog[entry.id] = {
        id: entry.id,
        config: {
          url,
          ...(tokenTemplate
            ? { authorizationToken: () => interpolate(tokenTemplate, resolveSecret) }
            : {}),
        },
      }
    } catch (err) {
      warnings.push(`mcp "${entry.id}" sin conectar: ${(err as Error).message}`)
    }
  }
  return catalog
}
