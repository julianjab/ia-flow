import {
  AGENT_MEMORY_KEY_MAX,
  AGENT_MEMORY_VALUE_MAX_BYTES,
  type AgentMemoryEntry,
} from '@ia-flow/shared'
import type { ToolContext } from '../contract.js'
import { registerTool } from '../engine.js'
import { createLogger } from '../logger.js'

// Tools `memory_*` — lo único que un agente se lleva de un run al siguiente.
//
// El namespace lo pone el RUNTIME, no el modelo: sale de `ctx.agentId` +
// `ctx.projectId`, que el provider ya tiene. Si el agente pudiera nombrar su
// propio namespace, escribir en el de otro agente sería un argumento de tool —
// o sea, una alucinación de distancia. Por eso no hay parámetro `agent_id`.
//
// Sin port cableado (tests, un proceso sin store) las tools contestan que la
// memoria no está disponible en vez de tirar: un agente sin memoria trabaja
// peor, no se cae.

const log = createLogger('tool-memory')

/** Vista angosta del store, cableada por el composition root de cada app.
 *  Async aunque hoy la implementación sea SQLite local: quien la mueva a un
 *  store remoto no debería tener que tocar estas cinco tools. */
export interface AgentMemoryPort {
  get(agentId: string, projectId: string, key: string): Promise<AgentMemoryEntry | null>
  list(agentId: string, projectId: string): Promise<AgentMemoryEntry[]>
  search(agentId: string, projectId: string, term: string): Promise<AgentMemoryEntry[]>
  upsert(entry: AgentMemoryEntry): Promise<void>
  deleteByKey(agentId: string, projectId: string, key: string): Promise<boolean>
}

let port: AgentMemoryPort | null = null

export function setAgentMemoryPort(p: AgentMemoryPort | null): void {
  port = p
}

const SCOPE_DESCRIPTION =
  "'project' (default) guarda la entrada sólo para el proyecto de esta corrida; 'global' la guarda para el agente en todos los proyectos."

/** Qué namespace toca esta llamada. `scope: 'global'` fuerza `projectId: ''`,
 *  que es la misma fila que ve un agente corriendo sin proyecto. */
function resolveNamespace(
  ctx: ToolContext | undefined,
  scope: unknown,
): { agentId: string; projectId: string } | { error: string } {
  const agentId = ctx?.agentId?.trim()
  if (!agentId) {
    return {
      error:
        'La memoria no está disponible en esta corrida: el runtime no informó qué agente la está usando.',
    }
  }
  const projectId = scope === 'global' ? '' : (ctx?.projectId?.trim() ?? '')
  return { agentId, projectId }
}

function unavailable(): string {
  return 'La memoria de agentes no está disponible en este proceso.'
}

function renderEntry(e: AgentMemoryEntry): string {
  return `- ${e.key} (actualizado ${e.updatedAt}): ${e.value}`
}

registerTool({
  name: 'memory_store',
  description:
    'Guarda un dato en tu memoria persistente para acordártelo en corridas futuras. Sobrescribe la key si ya existía. Usalo para decisiones tomadas, convenciones aprendidas o referencias (números de PR, nombres de branch) que te van a servir la próxima vez que despiertes sobre este trabajo.',
  input_schema: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        description: `Identificador corto y estable de lo que guardás (máximo ${AGENT_MEMORY_KEY_MAX} caracteres).`,
      },
      value: { type: 'string', description: 'El contenido a recordar.' },
      scope: { type: 'string', enum: ['project', 'global'], description: SCOPE_DESCRIPTION },
    },
    required: ['key', 'value'],
  },
  async execute(input: any, ctx?: ToolContext): Promise<string> {
    if (!port) return unavailable()
    const ns = resolveNamespace(ctx, input?.scope)
    if ('error' in ns) return ns.error

    const key = typeof input?.key === 'string' ? input.key.trim() : ''
    if (!key) return 'Falta `key`: no hay bajo qué nombre guardar esto.'
    if (key.length > AGENT_MEMORY_KEY_MAX) {
      return `La key excede ${AGENT_MEMORY_KEY_MAX} caracteres (tiene ${key.length}). Una key es un identificador, el contenido va en \`value\`.`
    }

    const value = typeof input?.value === 'string' ? input.value : ''
    const bytes = Buffer.byteLength(value, 'utf8')
    if (bytes > AGENT_MEMORY_VALUE_MAX_BYTES) {
      return `El value pesa ${bytes} bytes y el tope es ${AGENT_MEMORY_VALUE_MAX_BYTES}. Guardá un resumen o la ruta al archivo, no el archivo.`
    }

    await port.upsert({ ...ns, key, value, updatedAt: new Date().toISOString() })
    log.debug({ agentId: ns.agentId, projectId: ns.projectId, key, bytes }, 'memory stored')
    return `Guardado '${key}' en tu memoria${ns.projectId ? '' : ' global'}.`
  },
})

registerTool({
  name: 'memory_retrieve',
  description:
    'Lee de tu memoria persistente el valor que guardaste bajo una key. Devuelve el contenido tal cual lo escribiste, o avisa si esa key nunca se guardó.',
  input_schema: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'La key exacta que usaste al guardar.' },
      scope: { type: 'string', enum: ['project', 'global'], description: SCOPE_DESCRIPTION },
    },
    required: ['key'],
  },
  async execute(input: any, ctx?: ToolContext): Promise<string> {
    if (!port) return unavailable()
    const ns = resolveNamespace(ctx, input?.scope)
    if ('error' in ns) return ns.error

    const key = typeof input?.key === 'string' ? input.key.trim() : ''
    if (!key) return 'Falta `key`: no hay qué buscar.'

    const entry = await port.get(ns.agentId, ns.projectId, key)
    if (!entry) return `No hay nada guardado bajo '${key}'.`
    return entry.value
  },
})

registerTool({
  name: 'memory_search',
  description:
    'Busca en tu memoria persistente las entradas cuya key o cuyo contenido incluyen un término. Búsqueda literal por substring, sin interpretación semántica: usá una palabra que estimes que escribiste, no una pregunta.',
  input_schema: {
    type: 'object',
    properties: {
      term: { type: 'string', description: 'Substring a buscar (no distingue mayúsculas).' },
      scope: { type: 'string', enum: ['project', 'global'], description: SCOPE_DESCRIPTION },
    },
    required: ['term'],
  },
  async execute(input: any, ctx?: ToolContext): Promise<string> {
    if (!port) return unavailable()
    const ns = resolveNamespace(ctx, input?.scope)
    if ('error' in ns) return ns.error

    const term = typeof input?.term === 'string' ? input.term.trim() : ''
    if (!term) return 'Falta `term`: no hay qué buscar.'

    const found = await port.search(ns.agentId, ns.projectId, term)
    if (found.length === 0) return `Ninguna entrada de tu memoria menciona '${term}'.`
    return found.map(renderEntry).join('\n')
  },
})

registerTool({
  name: 'memory_list',
  description:
    'Lista las keys guardadas en tu memoria persistente, con su fecha de última escritura y sin el contenido. Sirve como inventario: para leer un valor concreto usá memory_retrieve.',
  input_schema: {
    type: 'object',
    properties: {
      scope: { type: 'string', enum: ['project', 'global'], description: SCOPE_DESCRIPTION },
    },
    required: [],
  },
  async execute(input: any, ctx?: ToolContext): Promise<string> {
    if (!port) return unavailable()
    const ns = resolveNamespace(ctx, input?.scope)
    if ('error' in ns) return ns.error

    const entries = await port.list(ns.agentId, ns.projectId)
    if (entries.length === 0) return 'Tu memoria está vacía.'
    return entries.map((e) => `- ${e.key} (actualizado ${e.updatedAt})`).join('\n')
  },
})

registerTool({
  name: 'memory_delete',
  description:
    'Borra de tu memoria persistente la entrada guardada bajo una key. Sólo esa: el resto de tu memoria queda intacta. Usalo cuando lo que recordabas dejó de ser cierto.',
  input_schema: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'La key exacta a borrar.' },
      scope: { type: 'string', enum: ['project', 'global'], description: SCOPE_DESCRIPTION },
    },
    required: ['key'],
  },
  async execute(input: any, ctx?: ToolContext): Promise<string> {
    if (!port) return unavailable()
    const ns = resolveNamespace(ctx, input?.scope)
    if ('error' in ns) return ns.error

    const key = typeof input?.key === 'string' ? input.key.trim() : ''
    if (!key) return 'Falta `key`: no hay qué borrar.'

    const deleted = await port.deleteByKey(ns.agentId, ns.projectId, key)
    return deleted ? `Borrado '${key}'.` : `No había nada guardado bajo '${key}'.`
  },
})
