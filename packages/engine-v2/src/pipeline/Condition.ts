export type ConditionOp = '=' | '!=' | '>' | '<' | 'contains' | 'in'

/** Un `when` de v1 (WhenConditionSchema). `logic` conecta esta condición con
 *  la siguiente del array ('and' es el default cuando se omite). */
export class Condition {
  readonly field: string
  readonly op: ConditionOp
  readonly value?: string
  readonly logic?: 'and' | 'or'

  constructor(field: string, op: ConditionOp, value?: string, logic?: 'and' | 'or') {
    this.field = field
    this.op = op
    this.value = value
    this.logic = logic
  }

  /** Lee `payload[this.field]` (soporta paths anidados tipo 'pr.head.ref') y aplica `op`. */
  evaluate(payload: Record<string, unknown>): boolean {
    const actual = Condition.getPath(payload, this.field)
    switch (this.op) {
      case '=':
        return String(actual) === this.value
      case '!=':
        return String(actual) !== this.value
      case '>':
        return Number(actual) > Number(this.value)
      case '<':
        return Number(actual) < Number(this.value)
      case 'contains':
        if (Array.isArray(actual)) return actual.map(String).includes(this.value ?? '')
        return typeof actual === 'string' && actual.includes(this.value ?? '')
      case 'in':
        return (this.value ?? '').split(',').includes(String(actual))
      default:
        return false
    }
  }

  /** Pública porque HttpAction la reusa para interpolar `{{path}}` en
   *  url/headers/body — mismo recorrido de path anidado, un solo lugar. */
  static getPath(payload: Record<string, unknown>, path: string): unknown {
    return path
      .split('.')
      .reduce<unknown>(
        (acc, key) =>
          acc != null && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined,
        payload,
      )
  }

  /**
   * Evalúa un array completo respetando los conectores `and`/`or` por
   * condición: `logic` en `conditions[i]` dice cómo conecta con
   * `conditions[i+1]` (el `logic` del ÚLTIMO elemento no se usa — no hay
   * nada después). Sin condiciones ⇒ true (vacuo, mismo criterio que
   * `whenText` ausente en Conditional).
   */
  static evaluateAll(conditions: Condition[], payload: Record<string, unknown>): boolean {
    if (conditions.length === 0) return true
    let result = conditions[0].evaluate(payload)
    for (let i = 1; i < conditions.length; i++) {
      const connector = conditions[i - 1].logic ?? 'and'
      const next = conditions[i].evaluate(payload)
      result = connector === 'or' ? result || next : result && next
    }
    return result
  }

  /** Fila de `WhenConditionSchema` (v1) — traducción pura, sin I/O. */
  static fromRow(row: ConditionRow): Condition {
    return new Condition(row.field, row.op ?? '=', row.value, row.logic)
  }

  /**
   * `RuleSchema.when` (v1) admite dos formas: un array de condiciones, o un
   * shorthand legacy `Record<string, string>` (igualdad implícita entre
   * campo y valor, sin `logic` — todas ANDeadas). Normalizarlo ACÁ, no en
   * `Pipeline.fromRow`, mantiene a `Pipeline` sin conocer las dos formas.
   */
  static fromRows(rows: ConditionRow[] | Record<string, string> | undefined): Condition[] {
    if (rows == null) return []
    if (Array.isArray(rows)) return rows.map(Condition.fromRow)
    return Object.entries(rows).map(([field, value]) => new Condition(field, '=', value))
  }
}

/** Forma larga de `WhenConditionSchema` (v1) — `Condition.fromRows` acepta
 *  además el shorthand legacy `Record<string,string>`. */
export interface ConditionRow {
  field: string
  op?: ConditionOp
  value?: string
  logic?: 'and' | 'or'
}
