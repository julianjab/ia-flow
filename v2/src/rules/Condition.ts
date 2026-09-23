export type ConditionOp = '=' | '!=' | '>' | '<' | 'contains' | 'in'

/** Un `when` de v1 (WhenConditionSchema), evaluado contra el payload del evento
 *  o los campos custom del Task (Task.fields, ver evalCondition en v1). */
export class Condition {
  readonly field: string
  readonly op: ConditionOp
  readonly value: unknown

  constructor(field: string, op: ConditionOp, value: unknown) {
    this.field = field
    this.op = op
    this.value = value
  }

  evaluate(payload: Record<string, unknown>): boolean {
    throw new Error('not implemented — replica evalCondition de v1 (lee payload[field], aplica op)')
  }
}
