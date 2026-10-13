export interface GatewayConfig {
  host: string
  port: number
  /** El bearer que el cliente (iTerm2…) manda como "API key" del gateway. */
  token: string
  /** La key REAL de Anthropic: nunca sale de este proceso. */
  apiKey: string
  models: string[]
  defaultModel: string
  defaultMaxTokens: number
  /** Se antepone al `system` que mande el cliente. Vacío = no se agrega nada. */
  systemPrompt: string
}

const DEFAULT_MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5']
const MIN_TOKEN_LENGTH = 16

function requireVar(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`llm-gateway: falta ${name}`)
  return value
}

function parsePositiveInt(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`llm-gateway: ${name} debe ser un entero positivo (recibí "${raw}")`)
  }
  return value
}

/** Lee la config del entorno. Falla en el arranque —no en el primer request— si falta una
 *  credencial: un gateway sin token o sin key no debe quedar escuchando. */
export function parseConfig(env: Record<string, string | undefined>): GatewayConfig {
  const token = requireVar(env, 'LLM_GATEWAY_TOKEN')
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `llm-gateway: LLM_GATEWAY_TOKEN debe tener al menos ${MIN_TOKEN_LENGTH} caracteres`,
    )
  }
  const apiKey = requireVar(env, 'ANTHROPIC_API_KEY')
  const configured = (env.LLM_GATEWAY_MODELS ?? '')
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean)
  const models = configured.length > 0 ? configured : DEFAULT_MODELS
  const defaultModel = env.LLM_GATEWAY_DEFAULT_MODEL?.trim() || models[0]
  if (!defaultModel) throw new Error('llm-gateway: no hay modelo por defecto')
  return {
    host: env.LLM_GATEWAY_HOST?.trim() || '127.0.0.1',
    port: parsePositiveInt(env.LLM_GATEWAY_PORT, 'LLM_GATEWAY_PORT', 4141),
    token,
    apiKey,
    models,
    defaultModel,
    defaultMaxTokens: parsePositiveInt(env.LLM_GATEWAY_MAX_TOKENS, 'LLM_GATEWAY_MAX_TOKENS', 4096),
    systemPrompt: env.LLM_GATEWAY_SYSTEM_PROMPT?.trim() ?? '',
  }
}
