// Compartido entre el provider principal (loop de agente) y cualquier otro
// caller server-side que necesite hablar con la Anthropic API — hoy también
// lo usa `application/branch-namer.ts` para pedir a Claude un nombre de branch
// legible cuando el engine auto-crea la linked branch de una task.

export const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'

export function buildAnthropicAuthHeader(): Record<string, string> {
  const oauthToken = Bun.env.CLAUDE_CODE_OAUTH_TOKEN
  const apiKey = Bun.env.ANTHROPIC_API_KEY
  if (oauthToken) return { Authorization: `Bearer ${oauthToken}` }
  if (apiKey) return { 'x-api-key': apiKey }
  throw new Error('No auth configured: set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY')
}
