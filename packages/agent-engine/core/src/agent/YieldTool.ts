import { z } from 'zod'
import { SchemaTool } from './SchemaTool.js'

/** Nombre de la tool con la que el modelo cede su turno cuando lo interrumpen. */
export const YIELD_TOOL_NAME = 'yield_turn'

const YieldInput = z.strictObject({
  progress: z
    .string()
    .min(1)
    .describe(
      'En qué quedaste: qué hiciste, qué falta, y cualquier cosa que el siguiente necesite',
    ),
})

/**
 * Cómo termina su turno un agente al que interrumpieron (`Execution.interrupt`): cuenta en qué quedó
 * y no elige salida — la pipeline corre su `onInterrupt` con eso en `steps.interruption.progress`.
 * Sólo se ofrece dentro de una ejecución, y sólo se acepta si de verdad lo interrumpieron: un
 * modelo que la llama por su cuenta recibe un error y sigue.
 */
export class YieldTool extends SchemaTool<typeof YieldInput> {
  readonly name = YIELD_TOOL_NAME
  readonly description =
    'Cedé tu turno SÓLO si el sistema te avisó que la task cambió y viene otra ejecución. Contá en qué quedaste. Nunca la uses por tu cuenta: para terminar el trabajo usá las submit_*.'
  readonly input = YieldInput
  readonly terminal = true
  /** No es una salida: el provider no la cuenta al insistirle al modelo que elija una (con ella,
   *  un agente con una sola salida sin datos pasaría a tener dos terminales y lo empujaría). */
  readonly failure = true

  constructor(
    private readonly interrupted: () => boolean,
    private readonly onYield: (progress: string) => void,
  ) {
    super()
  }

  protected execute(input: z.infer<typeof YieldInput>): string {
    if (!this.interrupted()) {
      throw new Error('Nadie te interrumpió: seguí con tu trabajo y terminá con una submit_*.')
    }
    this.onYield(input.progress)
    return 'Turno cedido. Terminaste.'
  }
}
