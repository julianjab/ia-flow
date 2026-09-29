import type {
  Action,
  FunctionActionProps,
  McpServerRef,
  ProviderRegistry,
  SystemPromptCatalog,
  Tool,
  ToolInputSchema,
} from '@ia-flow/agent-engine'
import type { StepFactory } from './StepFactory.js'

/** Para quién se arma una acción que depende de dónde se usa. */
export interface ActionRequest {
  sourceId: string
  /** El agente que la recibe como tool, o dueño del paso (su `onStart`, sus rutas, su `report`). */
  agentId?: string
  /** Las `options` de la entrada en la definición. */
  options: Record<string, unknown>
}

/**
 * Una acción que se arma a pedido: por fuente (un board distinto), por agente (un comentario con
 * su nombre) o con opciones propias (qué comandos puede correr). Varias acciones de una entrada
 * sólo tienen sentido como tools de un agente.
 */
export type ActionProvider = (request: ActionRequest) => Action | Action[]

/** Un host al que los pasos `http` le hablan por nombre, con su credencial. */
export interface HttpConnection {
  /** Ej. `https://api.github.com`. El path de cada paso se agrega acá: no puede cambiar el host. */
  baseUrl: string
  /** Los headers de cada request (ej. el token, que puede vencer: se piden en cada una). */
  headers?: () => Record<string, string> | Promise<Record<string, string>>
  /** Default: el `fetch` global. */
  fetch?: typeof fetch
}

/** Un registry de tools por nombre (ej. un `ToolRegistry` de `@ia-flow/github-tools`). */
export interface ToolLookup {
  get(name: string): Tool
}

/**
 * Lo que una definición nombra y la app registra en código. Una definición nunca trae funciones: una acción,
 * una tool, un schema de input o cómo se arma el input de un `onError` a partir del error se
 * referencian por nombre acá.
 */
export interface Catalogs {
  /** Los providers que los agentes nombran en `provider`. Default: el `providerRegistry` global. */
  providers?: ProviderRegistry
  /** Acciones por nombre: `{ action: postComment, with: {...} }`. Una fija, o una que se arma a
   *  pedido (`ActionProvider`). */
  actions?: Record<string, Action | ActionProvider>
  /** Servidores MCP por id, para `mcpServers:` de un agente. */
  mcpServers?: Record<string, McpServerRef>
  /** Funciones para `{ function: <nombre> }` (un `FunctionAction`). */
  functions?: Record<string, FunctionActionProps['fn']>
  /** Tools por nombre, para `tools:` de un agente. */
  tools?: Record<string, Tool> | ToolLookup
  /** El input de un destino o del reporte de un `onError`, a partir del error. */
  mappers?: Record<string, (err: Error) => unknown>
  /** Schemas por nombre, para el `input:` de un agente. */
  schemas?: Record<string, ToolInputSchema>
  /** Los system prompts que un agente referencia por `id`. */
  systemPrompts?: SystemPromptCatalog
  /** Las conexiones que nombra un paso `http` (`connection: github`): a qué host va y con qué
   *  credencial. El secreto vive acá, en código; la definición sólo pone el path. */
  connections?: Record<string, HttpConnection>
  /** Tipos de paso propios, además de los incluidos (`agent`, `action`, `emit`, `http`, `pause`,
   *  `function`). */
  steps?: StepFactory[]
}

/** Lo que `catalog` tiene bajo `name`, o un error que dice qué hay. */
export function lookup<T>(catalog: Record<string, T> | undefined, name: string, kind: string): T {
  const found = catalog?.[name]
  if (found === undefined) {
    const available = Object.keys(catalog ?? {})
    throw new Error(
      `no hay ${kind} "${name}" en el catálogo${available.length > 0 ? ` — hay: ${available.join(', ')}` : ' (está vacío)'}`,
    )
  }
  return found
}
