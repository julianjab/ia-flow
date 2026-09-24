import { Condition } from '../pipeline/Condition.js'
import { Catalog } from '../shared/Catalog.js'

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
 * Se autoindexa por id (estático) igual que Execution — mismo motivo: una
 * clase `ProjectRegistry` aparte sólo para `Map + get` no paga su lugar.
 * `Engine.dispatch` usa `Project.resolve(event.scope?.projectId)` en vez de
 * recibir un registry inyectado.
 */
export class Project {
  private static readonly catalog = new Catalog<Project>((p) => p.id)

  static register(project: Project): void {
    Project.catalog.register(project)
  }

  static resolve(id: string): Project | undefined {
    return Project.catalog.resolve(id)
  }

  static list(): Project[] {
    return Project.catalog.list()
  }

  /** Sólo para tests — vacía el índice estático entre corridas aisladas. */
  static reset(): void {
    Project.catalog.reset()
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

  /** Simétrico a `fromRow` — usa el mismo nombre `disabledRuleIds` que v1
   *  (no `disabledPipelineIds`) para que una fila que guardó ESTA clase se
   *  pueda releer con `fromRow` sin ambigüedad, y para que el store propio
   *  de v2 (ver `packages/engine-v2-sqlite`) no invente un tercer shape. */
  toRow(): ProjectRow {
    return {
      id: this.id,
      settings: {
        maxConcurrentDispatches: this.settings.maxConcurrentDispatches,
        disabledRuleIds: this.settings.disabledPipelineIds,
        baseWhen: Condition.toRows(this.settings.baseWhen ?? []),
      },
    }
  }
}

/** Fila cruda de `Project` — la misma forma que lee `Project.fromRow` de v1
 *  (`packages/shared`), y la que usa el store propio de v2 para persistir
 *  (`packages/engine-v2-sqlite`): sólo lo que esta clase necesita, el resto
 *  (name/language/systemPrompts/Slack/timestamps) es válido en v1 pero sin
 *  lector acá (ver el purge de agnosticismo de esta misma clase). */
export interface ProjectRow {
  id: string
  settings?: {
    maxConcurrentDispatches?: number
    disabledRuleIds?: string[] | null
    baseWhen?: Parameters<typeof Condition.fromRows>[0]
  } | null
}
