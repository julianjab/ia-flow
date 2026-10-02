export type ConditionOp =
  | 'eq'
  | 'neq'
  | 'exists'
  | 'notExists'
  | 'in'
  | 'notIn'
  | 'contains'
  | 'notContains'
  | 'matches'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'

export interface ConditionRow {
  /** Path punteado sobre el payload, ej. "task.status" o "trip.origin". */
  field: string
  op: ConditionOp
  value?: unknown
  /** Compara contra OTRO campo del mismo payload en vez de un `value` fijo (ej. `changes.to`
   *  `neq` `changes.from`). No aplica a `matches`, cuyo patrón se compila al armar. */
  valueFrom?: string
  /** Cómo se combina con la condición anterior de la misma lista — default 'and'. */
  logic?: 'and' | 'or'
}

/** Un `when` puro sobre un payload — sin I/O, testeable sin levantar nada. */
export class Condition {
  readonly field: string
  readonly op: ConditionOp
  readonly value?: unknown
  readonly valueFrom?: string
  readonly logic: 'and' | 'or'
  /** La regex de un `matches`, compilada una vez al construir: un patrón inválido rompe ACÁ (al
   *  armar la pipeline, como un ruteo mal cableado) y no en cada `evaluate`, donde tiraría dentro
   *  del dispatch y tumbaría a las demás pipelines del evento. El texto que se testea suele venir
   *  de terceros (el body de un comentario): el patrón tiene que ser lineal, sin backtracking
   *  catastrófico. */
  private readonly pattern?: RegExp

  constructor(row: ConditionRow) {
    this.field = row.field
    this.op = row.op
    this.value = row.value
    if (row.valueFrom !== undefined) {
      if (row.op === 'matches') {
        throw new Error(`condition ${row.field} matches: no admite valueFrom (el patrón es fijo)`)
      }
      this.valueFrom = row.valueFrom
    }
    this.logic = row.logic ?? 'and'
    if (row.op === 'matches' && typeof row.value === 'string') {
      try {
        this.pattern = new RegExp(row.value)
      } catch (error) {
        throw new Error(
          `condition ${row.field} matches: regex inválida ${JSON.stringify(row.value)} (${(error as Error).message})`,
        )
      }
    }
  }

  /** La condición y lo que vino en el payload — para explicar por qué algo no matcheó. */
  describe(payload: unknown): string {
    const expected =
      this.valueFrom !== undefined
        ? ` ${this.valueFrom} (${JSON.stringify(getPath(payload, this.valueFrom))})`
        : this.value === undefined
          ? ''
          : ` ${JSON.stringify(this.value)}`
    const actual = getPath(payload, this.field)
    return `${this.field} ${this.op}${expected} (vino ${actual === undefined ? 'nada' : JSON.stringify(actual)})`
  }

  evaluate(payload: unknown): boolean {
    const actual = getPath(payload, this.field)
    const value = this.valueFrom !== undefined ? getPath(payload, this.valueFrom) : this.value
    switch (this.op) {
      case 'eq':
        return actual === value
      case 'neq':
        return actual !== value
      case 'exists':
        return actual !== undefined && actual !== null
      case 'notExists':
        return actual === undefined || actual === null
      case 'in':
        return Array.isArray(value) && value.includes(actual)
      case 'notIn':
        return Array.isArray(value) && !value.includes(actual)
      case 'contains':
        if (Array.isArray(actual)) return actual.includes(value)
        if (typeof actual === 'string' && typeof value === 'string') {
          return actual.includes(value)
        }
        return false
      case 'notContains':
        if (Array.isArray(actual)) return !actual.includes(value)
        if (typeof actual === 'string' && typeof value === 'string') {
          return !actual.includes(value)
        }
        // Sin lista (campo ausente): no puede contener nada — mismo criterio que `neq`.
        return true
      case 'matches':
        // `value` es el source de una regex (ej. `^(?![\s\S]*<!-- ia-flow:)`, el filtro de
        // claw-agents para ignorar comentarios del propio pipeline). Sólo matchea strings.
        return typeof actual === 'string' && this.pattern !== undefined && this.pattern.test(actual)
      case 'gt':
        return typeof actual === 'number' && typeof value === 'number' && actual > value
      case 'gte':
        return typeof actual === 'number' && typeof value === 'number' && actual >= value
      case 'lt':
        return typeof actual === 'number' && typeof value === 'number' && actual < value
      case 'lte':
        return typeof actual === 'number' && typeof value === 'number' && actual <= value
      default:
        return false
    }
  }

  /** La fila de la que sale — el inverso de `new Condition(row)`, para guardarla (ej. la pausa
   *  de una ejecución persistida). */
  toRow(): ConditionRow {
    return {
      field: this.field,
      op: this.op,
      ...(this.value !== undefined ? { value: this.value } : {}),
      ...(this.valueFrom !== undefined ? { valueFrom: this.valueFrom } : {}),
      logic: this.logic,
    }
  }

  static fromRows(rows: ConditionRow[] | undefined): Condition[] {
    return (rows ?? []).map((row) => new Condition(row))
  }

  /**
   * Evalúa una lista de conditions con `and`/`or` en cadena (izquierda a derecha, sin
   * precedencia de operadores — el `logic` de cada entrada dice cómo se combina con el
   * resultado acumulado hasta ahí). Lista vacía = matchea siempre.
   */
  static evaluateAll(conditions: Condition[], payload: unknown): boolean {
    if (conditions.length === 0) return true
    let result = conditions[0].evaluate(payload)
    for (let i = 1; i < conditions.length; i++) {
      const condition = conditions[i]
      const value = condition.evaluate(payload)
      result = condition.logic === 'or' ? result || value : result && value
    }
    return result
  }
}

function getPath(source: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc == null || typeof acc !== 'object') return undefined
    return (acc as Record<string, unknown>)[key]
  }, source)
}
