// `submit_output` — la salida ESTRUCTURADA de un agente.
//
// Un agente cierra con prosa, y esa prosa es lo que el engine publica como
// comentario. Sirve para un humano y no para el paso siguiente: nadie puede
// leer "el brief para el implementer" de un párrafo sin volver a llamar a un
// modelo. Esta tool es el canal para lo que sí tiene que leerse por programa.
//
// ── Por qué una tool y no `output_config.format` de la API ─────────────────
//
// El canal de tools es lo ÚNICO que funciona igual en sync y en async — es
// literalmente por eso que el provider de terminal inyecta el MCP sintético
// `ia-flow-tools`. `output_config.format` sólo existe en `anthropic-api`, así
// que un contrato declarado no haría nada en tmux/iterm (el mismo modo de
// falla que los `fs_*` en terminal: capacidad declarada, silenciosamente
// ausente). Además se comería el mensaje final —que es lo que se publica en el
// issue— y no deja reintentar: acá un payload inválido vuelve como error de
// tool y el modelo corrige.
//
// ── Por qué no cierra el run ───────────────────────────────────────────────
//
// Es una contribución ANTES del cierre, no el cierre. Mezclarlos obligaría a
// tener dos cierres distintos según el provider (`complete_task` es
// async-only), que es exactamente de lo que este diseño escapa. El agente la
// llama y después cierra como siempre.
import { resolvePendingTask } from '@ia-flow/agent-engine'
import type { AgentOutput, AgentOutputField } from '@ia-flow/shared'
import type { ToolContext } from '../contract.js'
import { registerTool } from '../engine.js'
import { createLogger } from '../logger.js'

const log = createLogger('tool-submit-output')

/** Describe un campo para el modelo: su descripción más lo que el schema ya
 *  impone. Un campo sin `description` deja al modelo con el nombre pelado —
 *  el mismo problema que tenía una salida sin `when`. */
function describeField(name: string, field: AgentOutputField): Record<string, unknown> {
  const parts = [field.description?.trim()].filter(Boolean)
  if (field.optional) parts.push('(opcional)')
  return {
    type: field.type,
    ...(field.enum?.length ? { enum: field.enum } : {}),
    description: parts.join(' ') || `Campo '${name}' de la salida de este agente.`,
  }
}

/** El `typeof` contra un tipo declarado, con el switch explícito que exige el
 *  linter: `typeof x !== variable` no es comprobable estáticamente y es la
 *  forma en que se cuelan comparaciones contra strings que no existen. */
function matchesType(value: unknown, type: AgentOutputField['type']): boolean {
  switch (type) {
    case 'number':
      return typeof value === 'number'
    case 'boolean':
      return typeof value === 'boolean'
    default:
      return typeof value === 'string'
  }
}

/**
 * Valida el payload contra el contrato declarado.
 *
 * Devuelve los errores en vez de tirar: el caller los manda como resultado de
 * tool para que el modelo corrija y vuelva a llamar. Un contrato que se cumple
 * a medias no se acepta — el paso siguiente lo va a leer creyendo que está.
 */
export function validateOutput(
  fields: AgentOutput,
  payload: Record<string, unknown>,
): { ok: true; value: Record<string, unknown> } | { ok: false; errors: string[] } {
  const errors: string[] = []
  const value: Record<string, unknown> = {}

  for (const [name, field] of Object.entries(fields)) {
    const raw = payload[name]
    if (raw === undefined || raw === null || raw === '') {
      if (!field.optional) errors.push(`falta '${name}'`)
      continue
    }
    if (!matchesType(raw, field.type)) {
      errors.push(`'${name}' tiene que ser ${field.type} y vino ${typeof raw}`)
      continue
    }
    if (field.enum?.length && !field.enum.includes(String(raw))) {
      errors.push(`'${name}' tiene que ser uno de: ${field.enum.join(', ')} (vino '${raw}')`)
      continue
    }
    value[name] = raw
  }

  // Un campo de más casi siempre es un typo en el nombre de uno declarado, así
  // que se nombra en vez de descartarse en silencio: si se ignorara, el error
  // aparecería recién en el paso siguiente, como un valor vacío.
  const declared = new Set(Object.keys(fields))
  const extra = Object.keys(payload).filter((k) => !declared.has(k))
  if (extra.length) errors.push(`campos no declarados: ${extra.join(', ')}`)

  return errors.length ? { ok: false, errors } : { ok: true, value }
}

registerTool({
  name: 'submit_output',
  internal: true,
  // En los dos mundos, que es la razón de ser de este diseño.
  providerKinds: ['sync', 'async'],
  description:
    'Entrega la salida estructurada que este agente declara. NO cierra el run: registra el resultado para que el paso siguiente del pipeline lo lea. Llamala antes de cerrar.',
  input_schema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description:
          'Opcional — se resuelve del contexto del run. Completalo sólo si necesitás ser explícito.',
      },
    },
    required: [],
  },
  // El schema real depende del agente, así que se arma por dispatch — igual
  // que el enum de `select_exit`.
  specialize(opts) {
    const fields = opts?.outputFields
    if (!fields || Object.keys(fields).length === 0) return undefined
    const properties: Record<string, unknown> = {
      task_id: {
        type: 'string',
        description:
          'Opcional — se resuelve del contexto del run. Completalo sólo si necesitás ser explícito.',
      },
    }
    const required: string[] = []
    for (const [name, field] of Object.entries(fields)) {
      properties[name] = describeField(name, field)
      if (!field.optional) required.push(name)
    }
    return { type: 'object', properties, required }
  },
  hideWhen(opts) {
    return Object.keys(opts?.outputFields ?? {}).length === 0
  },
  async execute(rawInput: unknown, ctx?: ToolContext): Promise<string> {
    const input = (rawInput ?? {}) as Record<string, unknown>
    const taskId = String(input.task_id ?? ctx?.taskId ?? '')
    const resolved = await resolvePendingTask(taskId, ctx?.runId)
    if (!resolved) throw new Error(`No hay tarea activa con id '${taskId}'`)

    const { entry } = resolved
    const fields = entry.outputFields
    if (!fields || Object.keys(fields).length === 0) {
      throw new Error('Este agente no declara salida estructurada — no llames a submit_output.')
    }

    const { task_id: _ignored, ...payload } = input
    const result = validateOutput(fields, payload)
    if (!result.ok) {
      // Rechazo duro y con el detalle: no cierra el run, así que el modelo
      // puede corregir y volver a llamar. Mismo criterio que `select_exit` con
      // una salida no declarada.
      throw new Error(
        `La salida no cumple el contrato de este agente: ${result.errors.join('; ')}. ` +
          `Campos declarados: ${Object.keys(fields).join(', ')}.`,
      )
    }

    // Se pisa, no se acumula: si el agente la llama dos veces, vale la última.
    // Un historial acá no le sirve a nadie — el paso siguiente lee un valor.
    entry.structuredOutput = result.value
    log.info(
      {
        event: 'agent.output.submitted',
        taskId,
        agent: entry.agentId,
        campos: Object.keys(result.value),
      },
      'Salida estructurada entregada',
    )
    return `Salida registrada: ${Object.keys(result.value).join(', ')}.`
  },
})
