import { z } from 'zod'
import { SchemaTool } from './SchemaTool.js'

/** Nombre de la tool con la que el modelo cierra su turno declarando que falló. */
export const FAIL_TOOL_NAME = 'fail_turn'

const FailInput = z.strictObject({
  reason: z.string().min(1).describe('Por qué no pudiste terminar: qué falta, qué bloquea'),
})

/** El equivalente de `fail_task` de ia-flow: el modelo no puede o no debe terminar el trabajo
 *  (ambigüedad de producto, un bloqueo que no le toca resolver). La corrida falla con ese motivo
 *  y la pipeline aplica el `onError` de la cascada — ej. `+blocked` con el motivo en el reporte. */
export class FailTool extends SchemaTool<typeof FailInput> {
  readonly name = FAIL_TOOL_NAME
  readonly description =
    'Terminá tu turno declarando que NO pudiste completar el trabajo. Usala ante ambigüedad o un bloqueo que no te corresponde resolver, en vez de improvisar.'
  readonly input = FailInput
  readonly terminal = true
  readonly failure = true

  constructor(private readonly onFail: (reason: string) => void) {
    super()
  }

  protected execute(input: z.infer<typeof FailInput>): string {
    this.onFail(input.reason)
    return 'Falla registrada. Tu turno terminó.'
  }
}
