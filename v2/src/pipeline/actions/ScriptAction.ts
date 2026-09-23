import { Repo } from '../../domain/Repo.js'
import { getSecretResolver } from '../../infra/SecretResolver.js'
import { getShellRunner } from '../../infra/ShellRunner.js'
import { Condition } from '../Condition.js'
import {
  PipelineActionEntry,
  type PipelineActionEntryProps,
  type PipelineExecutionContext,
} from './PipelineActionEntry.js'

const INTERPRETER: Record<ScriptRuntime, string> = { bash: 'bash', python: 'python3' }

export type ScriptRuntime = 'bash' | 'python'

export interface ScriptActionProps extends PipelineActionEntryProps {
  runtime: ScriptRuntime
  /** Ruta RELATIVA al repo de la tarea — se valida en el adapter que no se escape. */
  file: string
  args?: string[]
  /**
   * Env vars a pasar, por NOMBRE — el script recibe SÓLO las claves listadas
   * acá, nunca el env completo del daemon (que tiene GITHUB_TOKEN,
   * ANTHROPIC_API_KEY...). El VALOR de cada entrada es una plantilla —
   * típicamente `${SECRETO}` — que se resuelve igual que url/headers/body de
   * HttpAction: primero `{{event...}}`, el secreto DESPUÉS (nunca al
   * revés — ver el comentario de HttpAction sobre por qué). Si
   * el valor viene de texto libre de la UI en vez de una referencia a
   * secreto, esto degrada al mismo riesgo que HttpAction.url (ver su
   * comentario) — no es una allow-list de VALORES, sólo de nombres.
   */
  env?: Record<string, string>
  timeoutMs?: number
}

/** Correr un script del repo. Apagado por default (IA_FLOW_ENABLE_SCRIPT_ACTIONS)
 *  porque es ejecución de código configurada desde una UI. */
export class ScriptAction extends PipelineActionEntry {
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

  /** Mismo orden que HttpAction.interpolate: `{{path}}` primero, `${SECRETO}` después. */
  private async resolveEnvValue(template: string, ctx: PipelineExecutionContext): Promise<string> {
    const root = { event: { type: ctx.event.type, payload: ctx.event.payload }, steps: ctx.steps }
    const withVars = template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
      const value = Condition.getPath(root as Record<string, unknown>, path)
      return value == null ? '' : String(value)
    })
    const match = withVars.match(/^\$\{([A-Z0-9_]+)\}$/)
    if (match == null) return withVars
    const resolver = getSecretResolver()
    if (resolver == null) {
      throw new Error(
        'ScriptAction.env necesita un SecretResolver — ver infra/SecretResolver.js (setSecretResolver)',
      )
    }
    return (await resolver.resolve(match[1])) ?? ''
  }

  async run(ctx: PipelineExecutionContext): Promise<unknown> {
    if (this.file.includes('..') || this.file.startsWith('/')) {
      throw new Error(`ScriptAction: path fuera del repo ("${this.file}")`)
    }

    const env: Record<string, string> = {}
    for (const [key, template] of Object.entries(this.env)) {
      env[key] = await this.resolveEnvValue(template, ctx)
    }

    const runner = getShellRunner()
    if (runner == null) {
      throw new Error('ScriptAction necesita un ShellRunner — ver infra/ShellRunner.js (setShellRunner)')
    }

    // Sin Provider (a diferencia de un AgentAction), la ÚNICA fuente de cwd
    // posible es el override manual de Repo.path — no hay a quién pedirle
    // un WorkspacePlan. `event.scope` ya trae projectId/repos (nunca hace
    // falta resolver una Task para esto). Si el repo no tiene `path`
    // seteado, ScriptAction no tiene dónde correr y lo dice, en vez de
    // adivinar `process.cwd()`.
    const projectId = ctx.event.scope?.projectId
    const repoName = ctx.event.scope?.repos?.[0]
    const repo = repoName != null && projectId != null ? Repo.resolve(projectId, repoName) : undefined
    if (repo?.path == null) {
      throw new Error(
        'ScriptAction necesita Repo.path seteado para el repo del evento — sin Provider no hay otra forma de resolver el cwd',
      )
    }

    const result = await runner.run(INTERPRETER[this.runtime], [this.file, ...this.args], {
      cwd: repo.path,
      env,
      timeoutMs: this.timeoutMs,
    })
    if (result.exitCode !== 0) {
      throw new Error(`ScriptAction "${this.file}" salió con código ${result.exitCode}: ${result.stderr}`)
    }
    return result
  }
}
