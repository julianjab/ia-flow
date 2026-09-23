import {
  RuleActionEntry,
  type RuleActionEntryProps,
  type RuleExecutionContext,
} from './RuleActionEntry.js'

export type ScriptRuntime = 'bash' | 'python'

export interface ScriptActionProps extends RuleActionEntryProps {
  runtime: ScriptRuntime
  /** Ruta RELATIVA al repo de la tarea — se valida en el adapter que no se escape. */
  file: string
  args?: string[]
  /**
   * Env vars a pasar, por NOMBRE — el script recibe SÓLO las claves listadas
   * acá, nunca el env completo del daemon (que tiene GITHUB_TOKEN,
   * ANTHROPIC_API_KEY...). El VALOR de cada entrada es una plantilla —
   * típicamente `${SECRETO}` — que se resuelve igual que url/headers/body de
   * HttpAction: secretos primero, interpolación de {{event...}} después. Si
   * el valor viene de texto libre de la UI en vez de una referencia a
   * secreto, esto degrada al mismo riesgo que HttpAction.url (ver su
   * comentario) — no es una allow-list de VALORES, sólo de nombres.
   */
  env?: Record<string, string>
  timeoutMs?: number
}

/** Correr un script del repo. Apagado por default (IA_FLOW_ENABLE_SCRIPT_ACTIONS)
 *  porque es ejecución de código configurada desde una UI. */
export class ScriptAction extends RuleActionEntry {
  readonly kind = 'script' as const
  readonly runtime: ScriptRuntime
  readonly file: string
  readonly args: string[]
  readonly env: Record<string, string>
  readonly timeoutMs?: number

  constructor(props: ScriptActionProps) {
    super(props)
    this.runtime = props.runtime
    this.file = props.file
    this.args = props.args ?? []
    this.env = props.env ?? {}
    this.timeoutMs = props.timeoutMs
  }

  async run(ctx: RuleExecutionContext): Promise<unknown> {
    throw new Error(
      'not implemented — validar path dentro del workspace, resolver env, spawnear this.runtime',
    )
  }
}
