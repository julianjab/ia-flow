/**
 * Un datasource de definiciones —YAML, SQLite, Postgres…— sólo traduce lo que tiene a
 * `SourceDocs`. Armar las entidades es uno solo para todos: `DefinitionPipelineSource`.
 */
import type {
  ExitDefaults,
  Pipeline,
  PipelineSource,
  StaticPipelineSource,
} from '@ia-flow/agent-engine'
import { createLogger } from '@ia-flow/telemetry'
import type { Catalogs } from './Catalogs.js'
import { SourceBuilder, type SourceDocs } from './SourceBuilder.js'

export interface DefinitionSource {
  /** Cambia cuando cambió algo de lo que `read()` devuelve (una fecha, un hash, una versión). */
  version(): string
  /** Las definiciones de la fuente. Tira si no son válidas, diciendo dónde. */
  read(): SourceDocs
}

/**
 * Las pipelines de un `DefinitionSource`, en vivo: el engine consulta `list()` en cada evento y,
 * si cambió la versión, se vuelven a leer y armar. Una versión inválida se loguea y sigue la
 * última buena — un typo no apaga la fuente —; la primera carga, en cambio, tira.
 *
 * Una pausa se reanuda en la pipeline con el mismo id; si su `do[]` cambió mientras esperaba, el
 * `Checkpoint` lo detecta y la ejecución falla en vez de seguir en otro paso.
 */
export class DefinitionPipelineSource implements PipelineSource {
  readonly log = createLogger('agent-engine.definitions')
  private current: StaticPipelineSource
  private loadedVersion: string

  constructor(
    private readonly datasource: DefinitionSource,
    private readonly catalogs: Catalogs = {},
  ) {
    this.loadedVersion = datasource.version()
    this.current = this.build()
  }

  get id(): string {
    return this.refresh().id as string
  }

  get defaults(): ExitDefaults {
    return this.refresh().defaults ?? {}
  }

  list(): Pipeline[] {
    return this.refresh().list()
  }

  private build(): StaticPipelineSource {
    return new SourceBuilder(this.catalogs).build(this.datasource.read())
  }

  private refresh(): StaticPipelineSource {
    const version = this.datasource.version()
    if (version === this.loadedVersion) return this.current
    // Se marca antes de cargar: una versión rota se loguea una vez, no en cada evento.
    this.loadedVersion = version
    try {
      this.current = this.build()
      this.log.info(`${this.current.id}: fuente recargada`, { 'ia.source.id': this.current.id })
    } catch (error) {
      this.log.error(
        `${this.current.id}: no se pudo recargar, sigue la versión anterior — ${(error as Error).message}`,
      )
    }
    return this.current
  }
}
