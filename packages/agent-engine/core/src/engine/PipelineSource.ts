import type { DomainEvent } from '../events/DomainEvent.js'
import type { Pipeline } from '../pipeline/Pipeline.js'
import type { Runnable } from '../pipeline/Runnable.js'
import type { ExitDefaults } from '../routing/ExitRoutes.js'

/**
 * Fuente en vivo del roster de Pipeline — el Engine la consulta en CADA evento, nunca la
 * cachea, así que un pipeline editado en caliente (DB, YAML, panel de admin) aplica en el
 * próximo dispatch sin reiniciar el proceso.
 */
export interface PipelineSource {
  list(): Promise<Pipeline[]> | Pipeline[]
  /** Quién es (ej. el id de un proyecto de la app): una pausa recuerda de qué fuente es su pipeline, para
   *  reanudarla ahí aunque otra fuente tenga una pipeline con el mismo id. */
  readonly id?: string
  /** Defaults de rutas para todas sus pipelines — el nivel "proyecto" de la cascada. */
  readonly defaults?: ExitDefaults
  /** Quién cumple cada capacidad según esta fuente (`EngineOptions.capabilities` decide cuál
   *  usa el engine: típicamente las de la fuente global). */
  readonly capabilities?: Record<string, Runnable>
  /**
   * El primer filtro de la cascada de `when` (fuente → pipeline → paso): por qué NINGUNA de sus
   * pipelines corre para `event`, o `undefined` si el evento pasa. Ausente = deja pasar todo.
   */
  explainMismatch?(event: DomainEvent<any>): string | undefined
}

export interface StaticPipelineSourceOptions {
  /** Ver `PipelineSource.id`. */
  id?: string
  /** Ver `PipelineSource.defaults`: el `onError`/`report` de todas sus pipelines. */
  defaults?: ExitDefaults
  /** Ver `PipelineSource.capabilities`. */
  capabilities?: Record<string, Runnable>
}

/**
 * Pipelines fijas para la vida del proceso — armadas en código, o cargadas por quien las lea de
 * otro lado (ej. una carpeta YAML). Con `id` y `defaults` es lo que una app llama "un proyecto":
 * el engine no sabe de proyectos, sólo de fuentes.
 */
export class StaticPipelineSource implements PipelineSource {
  readonly id?: string
  readonly defaults?: ExitDefaults
  readonly capabilities?: Record<string, Runnable>

  constructor(
    private readonly pipelines: Pipeline[],
    options: StaticPipelineSourceOptions = {},
  ) {
    const seen = new Set<string>()
    for (const pipeline of pipelines) {
      if (seen.has(pipeline.id)) {
        throw new Error(
          `${options.id ?? 'StaticPipelineSource'}: dos pipelines con el id "${pipeline.id}"`,
        )
      }
      seen.add(pipeline.id)
    }
    if (options.id !== undefined) this.id = options.id
    if (options.defaults) this.defaults = options.defaults
    if (options.capabilities) this.capabilities = options.capabilities
  }

  list(): Pipeline[] {
    return this.pipelines
  }
}
