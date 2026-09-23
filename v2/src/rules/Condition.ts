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
    throw new Error('not implemented — replica evalCondition de v1')
  }

  /** Evalúa un array completo respetando los conectores `and`/`or` por condición. */
  static evaluateAll(conditions: Condition[], payload: Record<string, unknown>): boolean {
    throw new Error('not implemented — replica evalWhen de v1')
  }
}
