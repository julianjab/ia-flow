/**
 * Cuánto pesa la conversación que se reenvía en cada vuelta. Dos palancas, las mismas que usa
 * Claude Code:
 *
 *   - Un resultado de tool enorme no entra entero (`clipToolResult`): el `Read` de Claude Code
 *     rechaza más de 25k tokens y le dice al modelo que pida un rango. Sin tope, un `CLAUDE.md` de
 *     300 KB son ~100k tokens que se reenvían en cada vuelta (subscriptions#1905).
 *   - Los resultados viejos se pueden borrar server-side (`clear_tool_uses` de context editing,
 *     opt-in: ver `clearToolUses` en `runConfig.ts`): la API los reemplaza por un aviso cuando la
 *     conversación pasa un umbral. Nosotros seguimos guardando el historial entero, así que
 *     checkpoints y reanudaciones no cambian.
 */
import type { AnthropicClearToolUsesConfig } from './runConfig.js'

export const CONTEXT_MANAGEMENT_BETA = 'context-management-2025-06-27'

/** Las perillas numéricas de `AnthropicClearToolUsesConfig` (las valida `runConfig.ts`). */
export const CLEAR_TOOL_USES_KEYS = ['triggerTokens', 'keepToolUses', 'clearAtLeastTokens'] as const

/** El trigger es el default de la API. `keep` más alto que el suyo (3): un agente que lee varios
 *  archivos y después escribe necesita tener a mano los últimos que leyó. */
const CLEAR_TOOL_USES_DEFAULTS = {
  triggerTokens: 100_000,
  keepToolUses: 5,
  clearAtLeastTokens: 20_000,
} as const satisfies AnthropicClearToolUsesConfig

/**
 * El `context_management` del body, o `undefined` si está apagado. Con `thinking` en el request va
 * además `clear_thinking` con `keep: 'all'`, primero (la API lo exige así), como lo manda Claude
 * Code: el default depende del modelo (los anteriores a Opus 4.5 conservan sólo el último turno),
 * y borrar thinking invalida la caché. Sin `thinking` no va: la API lo rechaza con 400.
 */
export function buildContextManagement(
  clearToolUses: boolean | AnthropicClearToolUsesConfig,
  thinking = false,
): Record<string, unknown> | undefined {
  if (clearToolUses === false) return undefined
  const config = { ...CLEAR_TOOL_USES_DEFAULTS, ...(clearToolUses === true ? {} : clearToolUses) }
  return {
    edits: [
      ...(thinking ? [{ type: 'clear_thinking_20251015', keep: 'all' }] : []),
      {
        type: 'clear_tool_uses_20250919',
        trigger: { type: 'input_tokens', value: config.triggerTokens },
        keep: { type: 'tool_uses', value: config.keepToolUses },
        clear_at_least: { type: 'input_tokens', value: config.clearAtLeastTokens },
        ...(config.excludeTools?.length ? { exclude_tools: config.excludeTools } : {}),
      },
    ],
  }
}

/** El resultado de una tool, recortado a `maxChars` con un aviso al final que dice cuánto se
 *  dejó afuera y cómo pedirlo. Se queda con el principio: un archivo o un listado se leen desde
 *  arriba. */
export function clipToolResult(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content
  return `${content.slice(0, maxChars)}

[Resultado recortado: se muestran los primeros ${maxChars} de ${content.length} caracteres. No pidas el contenido entero otra vez: pedí sólo la parte que necesitás (un rango de líneas, una búsqueda por texto o por símbolo).]`
}
