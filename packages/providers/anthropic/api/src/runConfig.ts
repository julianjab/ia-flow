/**
 * La config de UNA corrida de `AnthropicProvider`: qué perillas hay, cómo se valida cada una y
 * cómo se resuelve clave por clave (agente → provider → default del paquete).
 */
import { CLEAR_TOOL_USES_KEYS } from './context.js'

export type AnthropicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type McpTransport = 'connector' | 'client'
export type AnthropicThinkingConfig =
  | { type: 'adaptive' }
  | { type: 'enabled'; budgetTokens: number }

/** Las perillas del borrado server-side de resultados viejos de tools (`clear_tool_uses` de
 *  context editing). Lo que no se define cae al default de `context.ts`. */
export interface AnthropicClearToolUsesConfig {
  /** Desde cuántos tokens de entrada empieza a borrar. */
  triggerTokens?: number
  /** Cuántos pares `tool_use`/`tool_result` recientes quedan siempre enteros. */
  keepToolUses?: number
  /** Lo mínimo que tiene que borrar para hacerlo: cada borrado invalida la caché del prefijo, así
   *  que borrar poco cuesta más de lo que ahorra. */
  clearAtLeastTokens?: number
  /** Tools cuyos resultados no se borran nunca. */
  excludeTools?: string[]
}

/**
 * Las perillas de una corrida, con la MISMA estructura en los dos niveles donde se configuran:
 *
 * - al registrar el provider (`new AnthropicProvider({ ...defaults })`), para todos sus agentes;
 * - en el `providerConfig` de cada agente, que pisa clave por clave lo del provider.
 *
 * Lo que ninguno de los dos define cae al default del paquete (`RUN_CONFIG_DEFAULTS`).
 */
export interface AnthropicRunConfig {
  model?: string
  maxTokens?: number
  /** Tope de vueltas del loop de tools (respuestas con `tool_use`), para no quedar colgado si el
   *  modelo no converge. */
  maxToolRounds?: number
  /** Cuántos `pause_turn` SEGUIDOS se reanudan (runs largos con tools server-side: MCP remoto,
   *  thinking extendido) — vuelve a cero con cada vuelta de tools. Tope aparte: una pausa no
   *  es una vuelta de tools. */
  maxPauseTurnRetries?: number
  maxRetries?: number
  /** Default true — ver `AnthropicSendOptions.stream` en `AnthropicClient`. */
  stream?: boolean
  thinking?: AnthropicThinkingConfig
  /** Atajo de ia-flow para `thinking: { type: 'enabled', budgetTokens }`; gana sobre `thinking`. */
  thinkingBudgetTokens?: number
  effort?: AnthropicEffort
  taskBudgetTokens?: number
  /** Por default las tools de cada MCP van diferidas (`defer_loading` + una tool de búsqueda
   *  regex). `true` carga todo el catálogo desde el primer request. */
  eagerMcpTools?: boolean
  /** Cómo llegan los MCP del agente al modelo. `connector` (default): `mcp_servers`, y Anthropic
   *  se conecta. `client`: el provider se conecta él mismo y pasa sus tools como tools normales
   *  — el conector rechaza el OAuth de una suscripción de Claude Code desde 2026-10-15. */
  mcpTransport?: McpTransport
  /** Un corte por `max_tokens` reintenta UNA vez con el doble de presupuesto (tope 128000)
   *  antes de reportar `'truncated'`. Default true. */
  bumpMaxTokensOnTruncation?: boolean
  /** Bloques de system que van ANTES de los del agente: lo que este provider necesita que diga
   *  todo request, sea cual sea el agente (ej. la identidad que pide la API con un token de Claude
   *  Code). Puestos en el provider, valen para todos sus agentes; el agente los pisa enteros. */
  systemPrompts?: string[]
  /** Tope en caracteres del resultado de UNA tool que entra a la conversación; lo que sobra se
   *  recorta con un aviso para que el modelo pida sólo la parte que necesita (como el `Read` de
   *  Claude Code). Un archivo entero de 300 KB son ~100k tokens que se reenvían cada vuelta. */
  maxToolResultChars?: number
  /** Borrado server-side de resultados viejos de tools cuando la conversación crece (context
   *  editing). `true` con los defaults, un objeto para ajustarlos, `false` lo apaga. */
  clearToolUses?: boolean | AnthropicClearToolUsesConfig
}

/** El `providerConfig` de un agente: la misma `AnthropicRunConfig` que el provider, más lo que
 *  sólo tiene sentido para UNA corrida. */
export interface AnthropicAgentProviderConfig extends AnthropicRunConfig {
  /** Retoma una conversación truncada en vez de arrancar del prompt. */
  resumeMessages?: AnthropicMessage[]
}

export type AnthropicMessage = { role: 'user' | 'assistant'; content: unknown }

/** Lo que usa una corrida cuando ni el provider ni el agente definen la clave. Pensado para el
 *  caso simple — un agente que trabaja sobre un repo necesita bastante más (ver el runner). */
export const RUN_CONFIG_DEFAULTS = {
  maxTokens: 1024,
  maxToolRounds: 8,
  maxPauseTurnRetries: 3,
  maxRetries: 3,
  stream: true,
  eagerMcpTools: false,
  mcpTransport: 'connector',
  bumpMaxTokensOnTruncation: true,
  maxToolResultChars: 100_000,
  clearToolUses: true,
} as const satisfies AnthropicRunConfig

const EFFORTS: readonly AnthropicEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const isPositiveInt = (value: unknown) => Number.isInteger(value) && (value as number) > 0
const isNonNegativeInt = (value: unknown) => Number.isInteger(value) && (value as number) >= 0
const isBoolean = (value: unknown) => typeof value === 'boolean'
const isStringList = (value: unknown) =>
  Array.isArray(value) && value.every((text) => typeof text === 'string' && text.length > 0)

function isClearToolUses(value: unknown): boolean {
  if (isBoolean(value)) return true
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.entries(value).every(([key, field]) =>
    key === 'excludeTools'
      ? isStringList(field)
      : (CLEAR_TOOL_USES_KEYS as readonly string[]).includes(key) && isPositiveInt(field),
  )
}

/** Cómo se valida cada clave de `AnthropicRunConfig` — y la lista de las que existen: una clave
 *  que no está acá se rechaza, así un typo en el `providerConfig` rompe en vez de ignorarse. */
const RUN_CONFIG_CHECKS: Record<keyof AnthropicRunConfig, (value: unknown) => boolean> = {
  model: (value) => typeof value === 'string' && value.length > 0,
  maxTokens: isPositiveInt,
  maxToolRounds: isPositiveInt,
  maxPauseTurnRetries: isNonNegativeInt,
  maxRetries: isNonNegativeInt,
  stream: isBoolean,
  thinking: (value) => {
    const thinking = value as { type?: unknown; budgetTokens?: unknown } | null
    return (
      thinking?.type === 'adaptive' ||
      (thinking?.type === 'enabled' && isPositiveInt(thinking.budgetTokens))
    )
  },
  thinkingBudgetTokens: isPositiveInt,
  effort: (value) => EFFORTS.includes(value as AnthropicEffort),
  taskBudgetTokens: isPositiveInt,
  eagerMcpTools: isBoolean,
  mcpTransport: (value) => value === 'connector' || value === 'client',
  bumpMaxTokensOnTruncation: isBoolean,
  systemPrompts: isStringList,
  maxToolResultChars: isPositiveInt,
  clearToolUses: isClearToolUses,
}

/**
 * Valida un `providerConfig` de agente contra la misma estructura del provider. Tira ante una
 * clave desconocida o un valor con el tipo equivocado — el caller (un runner al montar sus
 * agentes) lo puede llamar al bootear para fallar antes de la primera corrida.
 */
export function parseAnthropicAgentConfig(
  raw: Record<string, unknown>,
): AnthropicAgentProviderConfig {
  const config: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue
    if (key === 'resumeMessages') {
      if (!Array.isArray(value))
        throw new Error('providerConfig.resumeMessages: tiene que ser una lista')
      config[key] = value
      continue
    }
    if (!Object.hasOwn(RUN_CONFIG_CHECKS, key)) {
      const known = [...Object.keys(RUN_CONFIG_CHECKS), 'resumeMessages'].join(', ')
      throw new Error(
        `providerConfig.${key}: no es una opción de AnthropicProvider (hay: ${known})`,
      )
    }
    if (!RUN_CONFIG_CHECKS[key as keyof AnthropicRunConfig](value)) {
      throw new Error(`providerConfig.${key}: valor inválido ${JSON.stringify(value)}`)
    }
    config[key] = value
  }
  return config as AnthropicAgentProviderConfig
}

export type ResolvedRunConfig = AnthropicRunConfig &
  Required<Pick<AnthropicRunConfig, 'model' | keyof typeof RUN_CONFIG_DEFAULTS>>

/** La config efectiva de una corrida, clave por clave: la del agente, si no la del provider, si
 *  no el default del paquete. */
export function resolveRunConfig(
  provider: AnthropicRunConfig,
  agent: AnthropicAgentProviderConfig,
): ResolvedRunConfig {
  const resolved: Record<string, unknown> = {}
  for (const key of Object.keys(RUN_CONFIG_CHECKS) as Array<keyof AnthropicRunConfig>) {
    resolved[key] = agent[key] ?? provider[key] ?? (RUN_CONFIG_DEFAULTS as AnthropicRunConfig)[key]
  }
  // `thinking` y `thinkingBudgetTokens` son dos formas de la MISMA perilla: se pisan juntas. Si el
  // agente define cualquiera, las del provider no cuentan — si no, un `thinkingBudgetTokens` del
  // provider le ganaría al `thinking: adaptive` del agente.
  if (agent.thinking !== undefined || agent.thinkingBudgetTokens !== undefined) {
    resolved.thinking = agent.thinking
    resolved.thinkingBudgetTokens = agent.thinkingBudgetTokens
  }
  return resolved as unknown as ResolvedRunConfig
}
