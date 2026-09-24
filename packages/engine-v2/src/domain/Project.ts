import { Condition } from '../pipeline/Condition.js'

export interface ProjectSettings {
  maxConcurrentDispatches?: number
  /** Pipelines globales que este proyecto decidió no correr. */
  disabledPipelineIds?: string[] | null
  /** ANDeado contra el `when` de CADA pipeline que corre en este proyecto, globales incluidas. */
  baseWhen?: Condition[] | null
}

export interface ProjectProps {
  id: string
  settings?: ProjectSettings
}

/** Fuente en vivo inyectada — un `Project` nunca se cachea en memoria. */
export interface ProjectSource {
  get(id: string): ProjectRow | undefined
}

/**
 * Un scope de capacidad + overrides de pipeline — nada más. El engine tiene
 * que ser agnóstico a CUALQUIER generador de eventos (GitHub, Slack, lo que
 * sea): por eso esta clase no carga `name`/`language`/`source`/timestamps
 * ni nada pensado para mostrarse en una UI o describir de dónde salen los
 * issues — eso vive en el adapter que genera los eventos, nunca en el
 * engine. Sólo sobreviven los dos campos que `Pipeline`/`AgentAction`
 * consultan de verdad: capacidad (`maxConcurrentDispatches`) y overrides de
 * matching (`disabledPipelineIds`, `baseWhen`).
 *
 * `resolve()` pega contra el `ProjectSource` inyectado en CADA llamada —
 * sin caché, mismo criterio que `Agent.resolve` (ver su comentario): un
 * proyecto editado en la UI aplica en el próximo dispatch. Inyectar es EL
 * mecanismo, también en tests — nada de un catálogo en memoria como modo
 * alternativo.
 */
export class Project {
  private static source?: ProjectSource

  static setSource(source: ProjectSource): void {
    Project.source = source
  }

  static resolve(id: string): Project | undefined {
    if (Project.source == null) {
      throw new Error('Project: falta inyectar un ProjectSource (ver Project.setSource)')
    }
    const row = Project.source.get(id)
    return row == null ? undefined : Project.fromRow(row)
  }

  readonly id: string
  settings: ProjectSettings

  constructor(props: ProjectProps) {
    this.id = props.id
    this.settings = props.settings ?? {}
  }

  /**
   * ¿Este proyecto apagó este pipeline heredado? Dos condiciones, las dos
   * importan: `pipeline.id` está en la lista Y el pipeline es GLOBAL
   * (`pipeline.projectId == null`) — lo segundo evita que apagar uno global
   * se lleve puesto uno propio que comparta id por casualidad (uno propio
   * ya tiene su propio `enabled`, que es donde se apaga). Toma un shape
   * mínimo en vez de `Pipeline` completo para no crear el ciclo Project↔Pipeline
   * (Pipeline.matches ya importa Project).
   */
  disablesPipeline(pipeline: { id: string; projectId?: string | null }): boolean {
    if (pipeline.projectId != null) return false
    return this.settings.disabledPipelineIds?.includes(pipeline.id) ?? false
  }

  /**
   * Traducción pura de una fila de `Project` (v1, `packages/shared`) —
   * `settings.disabledRuleIds` (v1) → `settings.disabledPipelineIds` (v2),
   * único nombre que no coincide; `baseWhen` viaja crudo (`WhenConditionSchema[]`)
   * y `Condition.fromRows` lo normaliza igual que hace `Pipeline.fromRow`.
   */
  static fromRow(row: ProjectRow): Project {
    return new Project({
      id: row.id,
      settings: {
        maxConcurrentDispatches: row.settings?.maxConcurrentDispatches ?? undefined,
        disabledPipelineIds: row.settings?.disabledRuleIds,
        baseWhen: Condition.fromRows(row.settings?.baseWhen ?? undefined),
      },
    })
  }
}

/** Fila cruda de `Project` (v1, `packages/shared`) — sólo lo que
 *  `Project.fromRow` lee; el resto (name/language/systemPrompts/Slack/
 *  timestamps) es válido en v1 pero sin lector acá (ver el purge de
 *  agnosticismo de esta misma clase). */
export interface ProjectRow {
  id: string
  settings?: {
    maxConcurrentDispatches?: number
    disabledRuleIds?: string[] | null
    baseWhen?: Parameters<typeof Condition.fromRows>[0]
  } | null
}
