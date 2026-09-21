import { isAbsolute, relative, resolve } from 'node:path'
import type { ActionContext, ActionHandler, ActionResult } from '@ia-flow/rules'
import { SCRIPT_ACTIONS_ENV, ScriptActionSchema } from '@ia-flow/shared'
import type { z } from 'zod'
import { createLogger } from '../../logger.js'
import { runScript } from './run-script.js'

const log = createLogger('action:script')

// `script` — correr un archivo del repo cuando pasa un evento.
//
// **Esto es ejecución de código arbitrario configurada desde una UI que puede
// no tener autenticación.** No es una razón para no hacerlo; es la razón por la
// que las guardas de abajo no son opcionales, y por la que la capacidad viene
// apagada.
//
// Las seis guardas, en el orden en que se aplican:
//
//   1. Habilitada explícitamente (`IA_FLOW_ENABLE_SCRIPT_ACTIONS`) Y con
//      `IA_FLOW_API_TOKEN` puesto. La capacidad peligrosa arrastra su propia
//      precondición en vez de confiar en que alguien se acuerde de las dos.
//   2. Hay un workspace: sin repo de tarea no hay dónde correr, y correr en el
//      cwd del daemon sería correr al lado de su config y sus credenciales.
//   3. La ruta cae DENTRO del workspace — un `..` que se escape se rechaza.
//   4. Sin shell: `Bun.spawn([interprete, archivo, ...args])`. Sin `sh -c` no
//      hay expansión ni inyección por interpolar valores del evento.
//   5. Env de allow-list. El script recibe sólo lo que declara; heredar el env
//      del daemon le entregaría el GITHUB_TOKEN y el ANTHROPIC_API_KEY. Los
//      valores (de `env` y de `args`) admiten `${SECRETO}` para que un token
//      no tenga que vivir literal en la regla — resuelto ANTES de interpolar
//      `{{event...}}`, para que un `${...}` que traiga el EVENTO (el título
//      de un PR, un comentario) nunca se confunda con uno que escribió el
//      operador y se cambie por un secreto real.
//   6. Timeout y tope de salida, los mismos que `bash_run`.
//
// Y una que no es una guarda sino una decisión: corre SÓLO local, nunca viaja a
// un agent-host remoto. Mandar código a ejecutar a otra máquina es una decisión
// distinta y más grande.

type ScriptConfig = z.infer<typeof ScriptActionSchema>

export interface ScriptActionDeps {
  /** El repo sobre el que corre la tarea del evento. `null` ⇒ no hay dónde
   *  correr y la acción se rechaza. */
  workspaceFor(event: ActionContext['event']): Promise<string | null>
  /**
   * Resuelve `${SECRETO}` en `args` y en los VALORES de `env`, ANTES de
   * interpolar `{{event...}}`. Mismo resolver que usa la acción `http`
   * (`setSecretResolver`, compartido con los MCP) — así un script que necesita
   * pegarle a la propia API de ia-flow recibe su token por esta vía y no
   * escrito literal en la regla.
   *
   * El orden no es arbitrario: `resolveSecrets` no sabe distinguir un
   * `${...}` que escribió el operador de uno que trae el EVENTO (un PR/issue
   * de terceros puede tener `${GITHUB_TOKEN}` literal en el título). Resolver
   * antes de interpolar limita lo que `resolveSecrets` ve a la plantilla de la
   * regla — nunca al contenido que aportó el evento.
   *
   * Los NOMBRES de `env` siguen siendo la allow-list (sin esto no hay forma de
   * limitar qué recibe el proceso); lo nuevo es de dónde puede salir el VALOR.
   */
  resolveSecrets(input: string): Promise<string>
  /** Inyectable para testear sin spawnear de verdad. */
  spawn?: typeof Bun.spawn
  /** Inyectable para testear los gates sin tocar el env del proceso. */
  env?: NodeJS.ProcessEnv
}

/** `{{event.payload.pr.number}}` → el valor. Mismo criterio que la acción
 *  http: un placeholder que no resuelve queda vacío y no como el `{{...}}`
 *  crudo, porque del otro lado no hay forma de distinguirlo de un valor. */
function interpolate(template: string, event: ActionContext['event']): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path: string) => {
    let current: unknown = { event }
    for (const seg of path.split('.')) {
      if (current == null || typeof current !== 'object') return ''
      current = (current as Record<string, unknown>)[seg]
    }
    if (current == null) return ''
    return typeof current === 'string' ? current : JSON.stringify(current)
  })
}

/**
 * La ruta resuelta, o `null` si se escapa del workspace.
 *
 * `relative` y no un `startsWith` sobre strings: `/repo-malo` empieza con
 * `/repo` y pasaría el chequeo ingenuo. Si el relativo arranca con `..` o es
 * absoluto, quedó afuera.
 */
export function resolveInsideWorkspace(workspace: string, file: string): string | null {
  const full = resolve(workspace, file)
  const rel = relative(workspace, full)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  return full
}

export class ScriptAction implements ActionHandler<ScriptConfig> {
  readonly kind = 'script'
  readonly configSchema = ScriptActionSchema

  constructor(private readonly deps: ScriptActionDeps) {}

  /** Guarda 1: habilitada Y con token de API. Se lee por ejecución y no al
   *  construir — el env de la DB llega después de importar los módulos. */
  private gate(): string | null {
    const env = this.deps.env ?? process.env
    if (env[SCRIPT_ACTIONS_ENV] !== '1' && env[SCRIPT_ACTIONS_ENV] !== 'true') {
      return `las acciones script están deshabilitadas (${SCRIPT_ACTIONS_ENV}=1 para habilitarlas)`
    }
    if (!env.IA_FLOW_API_TOKEN?.trim()) {
      return 'las acciones script exigen IA_FLOW_API_TOKEN: sin auth en la API, cualquiera que la alcance ejecuta código en esta máquina'
    }
    return null
  }

  async execute(ctx: ActionContext, config: ScriptConfig): Promise<ActionResult> {
    const blocked = this.gate()
    if (blocked) {
      log.warn({ ruleId: ctx.rule.id, file: config.file }, blocked)
      return { ok: false, detail: blocked }
    }

    const workspace = await this.deps.workspaceFor(ctx.event)
    if (!workspace) {
      return { ok: false, detail: 'el evento no tiene un repo sobre el que correr el script' }
    }

    const script = resolveInsideWorkspace(workspace, config.file)
    if (!script) {
      return { ok: false, detail: `la ruta '${config.file}' se sale del workspace` }
    }

    // `${SECRETO}` resuelve ANTES de `{{event...}}`, sobre la plantilla cruda
    // de la regla — nunca al revés. La acción http resuelve en el orden
    // contrario y hereda el mismo riesgo, pero ahí el destino es una URL
    // externa; acá es argv/env de un proceso local, así que el orden importa
    // más. Si resolviera después, un campo del evento que un PR/issue puede
    // escribir (el título, un comentario) con el texto literal
    // `${GITHUB_TOKEN}` haría que `resolveSecrets` —que no distingue de dónde
    // vino el `${...}`— lo cambiara por el secreto real. Resolviendo antes,
    // lo único que puede contener un `${...}` es lo que el OPERADOR escribió
    // en la regla; el valor que deja el evento ya no vuelve a pasar por acá.
    const args = await Promise.all(
      (config.args ?? []).map(async (a) =>
        interpolate(await this.deps.resolveSecrets(a), ctx.event),
      ),
    )

    // Env de allow-list: SÓLO lo declarado. Nada del env del daemon.
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(config.env ?? {})) {
      env[k] = interpolate(await this.deps.resolveSecrets(v), ctx.event)
    }

    log.info(
      {
        ruleId: ctx.rule.id,
        script,
        runtime: config.runtime,
        envKeys: Object.keys(config.env ?? {}),
      },
      'Corriendo script',
    )

    const result = await runScript(
      {
        file: script,
        runtime: config.runtime,
        cwd: workspace,
        args,
        env,
        timeoutMs: config.timeoutMs,
      },
      { spawn: this.deps.spawn },
    )

    if (!result.ok) {
      return {
        ok: false,
        detail: `exit ${result.exitCode}${result.combined ? `: ${result.combined}` : ''}`,
      }
    }
    // `detail` es el resumen para el log —stdout Y stderr, truncado—; `output`
    // es SÓLO stdout y sin mezclar, porque es lo que puede leer el paso
    // siguiente. Un warning en stderr no tiene por qué corromper el valor.
    return { ok: true, detail: result.combined || 'exit 0', output: result.stdout.trim() }
  }
}
