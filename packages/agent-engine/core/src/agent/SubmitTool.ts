import type { ResolvedExit } from '../routing/ExitRoutes.js'
import { submitSchemaFor } from '../routing/ExitRoutes.js'
import { SchemaTool, type ToolInputSchema } from './SchemaTool.js'

/** La salida que eligió el modelo y lo que entregó para los pasos a los que lleva. */
export interface Submission {
  exit: string
  payload: Record<string, unknown>
}

/** `submit_<salida>`: el modelo termina su turno eligiendo esa salida; su schema es el input de
 *  los pasos a los que lleva (`submitSchemaFor`). */
export class SubmitTool extends SchemaTool<ToolInputSchema> {
  readonly name: string
  readonly description: string
  readonly input: ToolInputSchema
  readonly terminal = true

  constructor(
    agentId: string,
    private readonly exit: ResolvedExit,
    private readonly onSubmit: (submission: Submission) => void,
  ) {
    super()
    this.name = `submit_${exit.name}`
    this.description = exit.when
      ? `Terminá tu turno con la salida "${exit.name}". Usala cuando: ${exit.when}`
      : `Terminá tu turno con la salida "${exit.name}".`
    this.input = submitSchemaFor(agentId, exit)
  }

  protected execute(input: Record<string, unknown>): string {
    this.onSubmit({ exit: this.exit.name, payload: input })
    return `Salida "${this.exit.name}" registrada. Tu turno terminó.`
  }
}
