#!/usr/bin/env bun
// PostToolUse hook — captura `tool_use` / `tool_result` de Claude Code CLI
// (providers `iterm-claude` / `tmux-claude`) y los reenvía al servidor de
// ia-flow. El servidor los reemite como log entries en `daemon.log` con el
// mismo shape que emite el provider `anthropic-api`, para que el drawer de
// ejecuciones en la UI web muestre las tarjetas de tool.call/tool.result
// también para runs async.
//
// Este archivo se envía como util referenciado desde el `settings.json`
// temporal que `buildClaudeCommand` genera por run (writeRunSettings). Vive
// junto a `base.ts` para que `new URL('./hook-tool-use.ts', import.meta.url)`
// resuelva su path absoluto sin depender del cwd donde se lance `claude`.
//
// Contrato del hook (stdin JSON, formato Claude Code):
//   { session_id, transcript_path, tool_name, tool_input, tool_response }
// Ver: https://docs.claude.com/en/docs/claude-code/hooks#posttooluse
//
// Diseño:
// - No-op silencioso si IA_FLOW_RUN_ID no está seteado (el hook se registra
//   por-run, así que en teoría siempre está — el guard cubre corridas
//   manuales o tests locales).
// - `await fetch` con AbortSignal.timeout(3s): sin await el `process.exit(0)`
//   mata el proceso antes de que la request TCP salga.
// - Trunca tool_response a 10 KB antes de enviar para evitar entradas
//   gigantes en daemon.log.
// - Nunca throwea; cualquier error es swalloweado (`.catch(() => {})`).

export {}

const MAX_RESULT_BYTES = 10_000
const REQUEST_TIMEOUT_MS = 3_000

const runId = process.env.IA_FLOW_RUN_ID
if (!runId) process.exit(0)

const serverUrl = process.env.IA_FLOW_SERVER_URL ?? 'http://localhost:3001'

let raw: string
try {
  raw = await Bun.stdin.text()
} catch {
  process.exit(0)
}

let payload: unknown
try {
  payload = JSON.parse(raw)
} catch {
  process.exit(0)
}

const obj = (payload ?? {}) as Record<string, unknown>
const toolName = typeof obj.tool_name === 'string' ? obj.tool_name : 'unknown'
const toolInputRaw = obj.tool_input
const toolInput =
  toolInputRaw && typeof toolInputRaw === 'object' && !Array.isArray(toolInputRaw)
    ? (toolInputRaw as Record<string, unknown>)
    : {}
const toolResponse = obj.tool_response

// Claude Code no expone el `tool_use_id` original del modelo en los hooks.
// Sintetizamos uno determinístico por invocación (session prefix + tool +
// timestamp) suficientemente único para que el pairing tool.call ↔ tool.result
// funcione en groupRelatedLogs de la UI web.
const sessionId = typeof obj.session_id === 'string' ? obj.session_id : 'no-session'
const toolUseId = `${sessionId.slice(0, 8)}-${toolName}-${Date.now()}`

let result: string | undefined
if (toolResponse !== undefined) {
  const stringified = typeof toolResponse === 'string' ? toolResponse : JSON.stringify(toolResponse)
  if (typeof stringified === 'string') {
    result =
      stringified.length > MAX_RESULT_BYTES
        ? `${stringified.slice(0, MAX_RESULT_BYTES)}…[truncated]`
        : stringified
  }
}

// Await imprescindible: sin él, `process.exit(0)` corre antes de que el
// runtime despache la request TCP y el server nunca recibe el evento.
// AbortSignal.timeout acota lo que Claude Code espera por este hook.
await fetch(`${serverUrl}/api/hook-events`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ runId, toolName, toolUseId, input: toolInput, result }),
  signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
}).catch(() => {})

process.exit(0)
