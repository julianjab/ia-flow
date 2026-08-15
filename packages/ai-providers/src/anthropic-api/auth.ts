// Compartido entre el provider principal (loop de agente) y cualquier otro
// caller que necesite hablar con la Anthropic API.

export const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'

/**
 * Versión del wire protocol. Fijada en un solo lugar para que todos los
 * callers manden la misma header.
 */
export const ANTHROPIC_VERSION = '2023-06-01'

/**
 * Betas por default que activan capabilities Claude Code / OAuth / caching.
 */
export const CLAUDE_CODE_BETAS: readonly string[] = [
  'claude-code-20250219',
  'oauth-2025-04-20',
  'interleaved-thinking-2025-05-14',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
  'extended-cache-ttl-2025-04-11',
]

export function buildAnthropicAuthHeader(): Record<string, string> {
  const oauthToken = Bun.env.CLAUDE_CODE_OAUTH_TOKEN
  const apiKey = Bun.env.ANTHROPIC_API_KEY
  if (oauthToken) return { Authorization: `Bearer ${oauthToken}` }
  if (apiKey) return { 'x-api-key': apiKey }
  throw new Error('No auth configured: set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY')
}

/**
 * Construye el bloque de headers estándar que usan TODOS los callers a la
 * Anthropic API. Acepta betas extra (ej. `mcp-client-2025-04-04`).
 */
export function buildAnthropicHeaders(
  opts: { extraBetas?: readonly string[] } = {},
): Record<string, string> {
  const betas = new Set<string>(CLAUDE_CODE_BETAS)
  for (const b of opts.extraBetas ?? []) betas.add(b)
  return {
    'content-type': 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-beta': [...betas].join(','),
    ...buildAnthropicAuthHeader(),
  }
}
