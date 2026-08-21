// Construye el archivo `--mcp-config` que consume el CLI `claude` —
// compartido por cualquier provider que invoque ese CLI, sesión persistente
// (tmux/iterm) o headless (`claude -p`, claude-print). No depende de nada
// específico de una sesión de terminal (worktree, hooks, daemon local): es
// pura traducción de forma + escritura a disco.
import { randomUUID } from 'node:crypto'
import { chmod } from 'node:fs/promises'
import type { McpServers } from '@ia-flow/shared'

// Claude CLI's `.mcpServers` accepts http entries with `headers` but not la
// `authorizationToken` propia de ia-flow. Traducimos así un mismo shape de
// seed sirve tanto para la Anthropic API (authorization_token) como para el
// CLI (Bearer header).
function toCliMcpServers(servers: McpServers): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, srv] of Object.entries(servers)) {
    if (!('url' in srv)) {
      out[name] = srv
      continue
    }
    const { authorizationToken, headers, ...rest } = srv
    const mergedHeaders = { ...(headers ?? {}) }
    if (authorizationToken && !mergedHeaders.Authorization) {
      mergedHeaders.Authorization = `Bearer ${authorizationToken}`
    }
    out[name] = Object.keys(mergedHeaders).length ? { ...rest, headers: mergedHeaders } : rest
  }
  return out
}

/** Escribe un archivo temporal `--mcp-config` (JSON) para el CLI `claude`.
 *  Puede contener authorization tokens/headers — permisos owner-only. */
export async function writeMcpConfigFile(servers: McpServers): Promise<string> {
  const path = `/tmp/iaflow-mcp-${Date.now()}-${randomUUID().slice(0, 8)}.json`
  await Bun.write(path, JSON.stringify({ mcpServers: toCliMcpServers(servers) }, null, 2))
  await chmod(path, 0o600)
  return path
}
