import type { PipelineExecutionContext } from '../pipeline/Runnable.js'
import type { AgentVariableValue, McpServerRef, Tool } from './AgentDefinition.js'

/** Lo que `Agent.run()` arma para el Provider — el prompt ya interpolado, nunca `{{...}}`
 *  crudo. `ctx` es el `PipelineExecutionContext` completo del paso, por si un provider
 *  necesita algo que no está en los campos de arriba (poco común, pero ahí está). */
export interface ProviderRunContext {
  agentId: string
  prompt: string
  systemPrompts: string[]
  variables: Record<string, AgentVariableValue>
  providerConfig: Record<string, unknown>
  mcpServers: McpServerRef[]
  tools: Tool[]
  ctx: PipelineExecutionContext
  /** Mensajes que llegaron mientras el agente corre (sus `injects`), en orden — y los saca
   *  de la bandeja. Un provider con loop lo consulta antes de cada vuelta y los suma al próximo
   *  turno del usuario; uno sin loop puede ignorarlo. */
  inbox?: () => string[]
  /**
   * Retomar una conversación en vez de empezar del prompt: la que el provider devolvió al
   * esperar (`ProviderRunOutput.conversation`) o guardó mientras corría (`saveConversation`), y
   * lo que pasó mientras tanto (`message`: el evento que la despertó, que venció la espera, que
   * el runner se reinició). Es opaca para el engine: sólo la entiende el provider que la armó.
   */
  resume?: { conversation: unknown; message: string }
  /** Guardar la conversación en curso, para retomarla si el proceso muere a mitad de camino.
   *  Un provider con loop la pasa después de cada vuelta; uno sin conversación, nunca. */
  saveConversation?: (conversation: unknown) => void
}

/** Lo que un Provider reporta al terminar. `outcome` es el nombre que `matchExit` busca en
 *  `AgentDefinitionProps.exits` — típicamente 'success'/'error', o lo que el modelo decida. */
export interface ProviderRunOutput {
  outcome: string
  summary?: string
  structuredOutput?: Record<string, unknown>
  /** La conversación hasta la tool terminal que cerró el turno, incluidos sus resultados — lo
   *  que se retoma cuando el agente espera un evento (`wait_for_event`). Opaca, como en
   *  `ProviderRunContext.resume`. */
  conversation?: unknown
}

/**
 * Contrato que cualquier backend de IA implementa — Anthropic, OpenAI, un CLI corriendo en
 * una sesión de terminal, lo que sea. `run` es sólo `Promise<ProviderRunOutput>`: nada le
 * exige resolver rápido, así que un provider asíncrono (lanza un trabajo y se entera de que
 * terminó por un canal aparte — ver ia-flow's TmuxClaudeProvider) simplemente mantiene esa
 * promesa pendiente hasta ese momento. El harness no necesita saber la diferencia.
 */
export interface Provider {
  readonly id: string
  /** Cuántos agentes corren a la vez sobre este provider, entre todas las tasks. Default: sin
   *  tope (el engine sólo lo aplica si le da `EngineOptions.limits`). */
  readonly maxConcurrent?: number
  /**
   * Si puede tomar esta corrida ahora (ej. un host remoto con su propia capacidad). Se pregunta
   * con el lugar ya tomado; si dice que no, el agente suelta el lugar y espera `retryAfterMs`
   * antes de volver a preguntar — la corrida se demora, no falla.
   */
  canAccept?(request: { agentId: string; ctx: PipelineExecutionContext }): Promise<Admission>
  run(ctx: ProviderRunContext): Promise<ProviderRunOutput>
}

/** La respuesta de `Provider.canAccept`. */
export type Admission = { accept: true } | { accept: false; reason: string; retryAfterMs?: number }

/** Registry por id — un Provider se registra una vez y cualquier `AgentDefinitionProps` lo
 *  referencia por `provider: 'ese-id'`. Mismo patrón que `Provider.resolve(id)` en ia-flow. */
export class ProviderRegistry {
  private readonly providers = new Map<string, Provider>()

  register(provider: Provider): this {
    this.providers.set(provider.id, provider)
    return this
  }

  resolve(id: string): Provider | undefined {
    return this.providers.get(id)
  }
}

/**
 * Singleton module-level que `new Agent(def)` consulta por default. `ProviderRegistry` en sí
 * es una clase instanciable (no un singleton forzado) — si necesitás aislar registries entre
 * tests o entre apps del mismo proceso, `new ProviderRegistry()` y pasalo como segundo
 * argumento: `new Agent(def, registry)`.
 */
export const providerRegistry = new ProviderRegistry()
