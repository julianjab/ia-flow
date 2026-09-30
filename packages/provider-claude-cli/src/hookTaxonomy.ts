/**
 * Qué deja en los logs cada hook de Claude Code — la taxonomía de ia-flow v1
 * (`hook-tool-use.ts` + `routes/hook-events.ts`), ahora como logs estructurados colgados de la
 * traza del agente. Funciones puras: `RunChannel` las emite.
 */
import type { Attributes, LogLevel } from '@ia-flow/telemetry'
import { truncate } from '@ia-flow/telemetry'

/** Tope de un input, una respuesta o un prompt en un log (10 KB, como en v1). */
export const MAX_HOOK_BYTES = 10_000

export type HookEventName =
  | 'tool.pre'
  | 'tool.call'
  | 'tool.result'
  | 'subagent.start'
  | 'subagent.stop'
  | 'agent.prompt'
  | 'agent.stop'
  | 'agent.session_start'

/** Un log a emitir: `message` es el nombre de la taxonomía (también en `ia.hook.event`). */
export interface HookLog {
  level: LogLevel
  message: HookEventName | `hook ${string}`
  attributes: Attributes
}

/**
 * Si una respuesta de `PostToolUse` es una tool que falló. Claude Code no tiene un campo único:
 * casi todas traen `is_error`, algunas `success: false`, y `Bash` informa un exit ≠ 0 en
 * `stderr`/`interrupted` sin dejar de "funcionar". Sólo se confía en los flags explícitos — adivinar
 * por `stderr` contaría como error cada comando que escribe un warning. `undefined` cuando la
 * forma no dice nada: "no hubo error" y "no se sabe" no son lo mismo.
 */
export function detectToolError(response: unknown): boolean | undefined {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return undefined
  const r = response as Record<string, unknown>
  if (typeof r.is_error === 'boolean') return r.is_error
  if (typeof r.isError === 'boolean') return r.isError
  if (typeof r.success === 'boolean') return !r.success
  return undefined
}

const clip = (value: unknown) => truncate(value, MAX_HOOK_BYTES)
const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined)

/** `{ clave: valor }` sólo si el valor existe. */
function maybe(key: string, value: string | undefined): Attributes {
  return value === undefined ? {} : { [key]: value }
}

type Entry = (level: LogLevel, name: HookEventName, attributes: Attributes) => HookLog

/** Lo que identifica una tool en cualquiera de sus logs. */
function toolAttributes(input: Record<string, unknown>): Attributes {
  return {
    'gen_ai.tool.name': text(input.tool_name) ?? 'unknown',
    ...maybe('ia.tool.use_id', text(input.tool_use_id)),
    ...maybe('ia.tool.parent_use_id', text(input.parent_tool_use_id)),
  }
}

function preToolUse(log: Entry, input: Record<string, unknown>): HookLog[] {
  const tool = toolAttributes(input)
  if (input.tool_name === 'Task') {
    const task = (input.tool_input ?? {}) as Record<string, unknown>
    return [
      log('info', 'subagent.start', {
        ...tool,
        ...maybe('ia.subagent.type', text(task.subagent_type)),
        ...maybe('ia.subagent.description', text(task.description)),
        ...maybe('ia.subagent.prompt', text(task.prompt) && clip(task.prompt)),
      }),
    ]
  }
  // `debug`: es el mismo tool_use que llega como `tool.call` un instante después; sirve para lo
  // único que ése no muestra — una tool que arrancó y nunca volvió.
  return [log('debug', 'tool.pre', { ...tool, 'ia.tool.input': clip(input.tool_input) })]
}

function postToolUse(log: Entry, input: Record<string, unknown>): HookLog[] {
  const tool = toolAttributes(input)
  const isError = detectToolError(input.tool_response)
  return [
    log('info', 'tool.call', { ...tool, 'ia.tool.input': clip(input.tool_input) }),
    log('info', 'tool.result', {
      ...tool,
      ...(input.tool_response !== undefined ? { 'ia.tool.result': clip(input.tool_response) } : {}),
      ...(isError !== undefined ? { 'ia.tool.is_error': isError } : {}),
    }),
  ]
}

function stop(name: HookEventName) {
  return (log: Entry, input: Record<string, unknown>): HookLog[] => {
    const reason = input.stop_reason ?? input.reason
    return [
      log('info', name, {
        ...(reason !== undefined ? { 'ia.stop.reason': clip(reason) } : {}),
        ...(typeof input.stop_hook_active === 'boolean'
          ? { 'ia.stop.hook_active': input.stop_hook_active }
          : {}),
      }),
    ]
  }
}

const BY_HOOK: Record<string, (log: Entry, input: Record<string, unknown>) => HookLog[]> = {
  PreToolUse: preToolUse,
  PostToolUse: postToolUse,
  UserPromptSubmit: (log, input) => [
    log('info', 'agent.prompt', { 'ia.prompt': clip(text(input.prompt) ?? '') }),
  ],
  Stop: stop('agent.stop'),
  SubagentStop: stop('subagent.stop'),
  SessionStart: (log, input) => [
    log('info', 'agent.session_start', {
      ...maybe('ia.session.id', text(input.session_id)),
      ...maybe('ia.session.source', text(input.source)),
    }),
  ],
}

/** Los logs de un hook, en orden. `PostToolUse` deja el par `tool.call` + `tool.result`,
 *  apareados por `ia.tool.use_id`. Un hook que no está en la taxonomía, un `debug` suelto. */
export function hookLogs(event: string, input: Record<string, unknown>): HookLog[] {
  const describe = Object.hasOwn(BY_HOOK, event) ? BY_HOOK[event] : undefined
  if (!describe) {
    return [{ level: 'debug', message: `hook ${event}`, attributes: { 'ia.hook.name': event } }]
  }
  return describe(
    (level, name, attributes) => ({
      level,
      message: name,
      attributes: { 'ia.hook.event': name, 'ia.hook.name': event, ...attributes },
    }),
    input,
  )
}
