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
   *  turno del usuario; uno sin loop puede ignorarlo. Puede ser una promesa: leerla puede ser ir
   *  a buscarla a otra máquina (un host remoto pregunta al runner). Se llama en el momento en que
   *  el provider los va a usar, nunca antes: lo que se lee se da por leído, y lo que el agente no
   *  alcanzó a leer el engine lo re-despacha al cerrar la ejecución. */
  inbox?: () => string[] | Promise<string[]>
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
  /** El texto del modelo a medida que se escribe, un pedazo por llamada — para mostrarlo en vivo
   *  (el asistente de la web). Un provider que no puede streamear no lo llama nunca. */
  onText?: (delta: string) => void
  /** Cortar la corrida desde afuera (quien la delegó la dio por terminada: venció, se perdió).
   *  Un provider lo respeta en cuanto puede —entre vueltas, o matando su proceso— y devuelve un
   *  `outcome: 'error'` que dice por qué. */
  signal?: AbortSignal
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
/**
 * Con qué trabaja el modelo el worktree de la task. `runner` (default): con las tools del agente
 * que operan sobre él (`Tool.workspace`: `fs_*`, `bash_run`, …). `native`: con las suyas propias
 * (ej. el CLI de Claude Code: `Read`, `Edit`, `Bash`) — ésas no se le ofrecen: serían un segundo
 * juego de lo mismo, y en otra máquina, un segundo checkout.
 */
export type ProviderWorkspace = 'runner' | 'native'

/** Las tools que se le ofrecen a `provider`: sin las de workspace si el suyo es nativo. */
export function toolsFor<T extends Pick<Tool, 'workspace'>>(
  provider: Pick<Provider, 'workspace'>,
  tools: T[],
): T[] {
  return provider.workspace === 'native' ? tools.filter((tool) => !tool.workspace) : tools
}

export interface Provider {
  readonly id: string
  /** Ver `ProviderWorkspace`. Default: `runner`. */
  readonly workspace?: ProviderWorkspace
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
/** Cuánto espera un agente a un provider dinámico con nombre que no llega (ver `expectDynamic`). */
export const DEFAULT_DYNAMIC_WAIT_MS = 10 * 60_000

export class ProviderRegistry {
  private readonly providers = new Map<string, Provider>()
  /** Prefijo dinámico → cuánto se espera a un id con nombre de ese prefijo. */
  private readonly dynamicPrefixes = new Map<string, number>()
  private waiters: Array<() => void> = []

  /** Declara que los ids con este prefijo van y vienen (`remote:`, los hosts que se suscriben):
   *  un agente que nombra uno que todavía no está — o que se fue — lo espera hasta `maxWaitMs`
   *  (default 10 min), en vez de fallar al toque como con un id que nadie va a registrar. Pasado
   *  ese tope, falla diciendo que no llegó (un typo, un host que ya no existe). */
  expectDynamic(prefix: string, maxWaitMs = DEFAULT_DYNAMIC_WAIT_MS): this {
    this.dynamicPrefixes.set(prefix, maxWaitMs)
    return this
  }

  /** Si `id` es de los que van y vienen (ver `expectDynamic`). */
  isDynamic(id: string): boolean {
    return this.dynamicWaitMs(id) !== undefined
  }

  /** Cuánto se espera a `id` si es dinámico; `undefined` si no lo es. */
  dynamicWaitMs(id: string): number | undefined {
    for (const [prefix, maxWaitMs] of this.dynamicPrefixes) {
      if (id.startsWith(prefix)) return maxWaitMs
    }
    return undefined
  }

  register(provider: Provider): this {
    this.providers.set(provider.id, provider)
    this.notify()
    return this
  }

  /** Lo saca: un provider que va y viene (un host remoto que se suscribe y se va). */
  unregister(id: string): boolean {
    const removed = this.providers.delete(id)
    if (removed) this.notify()
    return removed
  }

  resolve(id: string): Provider | undefined {
    return this.providers.get(id)
  }

  /** Los registrados ahora, en el orden en que se registraron. */
  list(): Provider[] {
    return [...this.providers.values()]
  }

  /** Se resuelve con el próximo alta o baja: un agente que espera un provider que todavía no
   *  existe (`remote:*` sin hosts) se despierta cuando llega uno. */
  changed(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  private notify(): void {
    const waiters = this.waiters
    this.waiters = []
    for (const wake of waiters) wake()
  }
}

/**
 * Singleton module-level que `new Agent(def)` consulta por default. `ProviderRegistry` en sí
 * es una clase instanciable (no un singleton forzado) — si necesitás aislar registries entre
 * tests o entre apps del mismo proceso, `new ProviderRegistry()` y pasalo como segundo
 * argumento: `new Agent(def, registry)`.
 */
export const providerRegistry = new ProviderRegistry()
