import { isAbsolute, relative, resolve } from 'node:path'
import type { ActionContext, ActionHandler, ActionResult } from '@ia-flow/rules'
import { SCRIPT_ACTIONS_ENV, ScriptActionSchema } from '@ia-flow/shared'
import type { z } from 'zod'
import { createLogger } from '../../logger.js'

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
//      del daemon le entregaría el GITHUB_TOKEN y el ANTHROPIC_API_KEY.
//   6. Timeout y tope de salida, los mismos que `bash_run`.
//
// Y una que no es una guarda sino una decisión: corre SÓLO local, nunca viaja a
// un agent-host remoto. Mandar código a ejecutar a otra máquina es una decisión
// distinta y más grande.

type ScriptConfig = z.infer<typeof ScriptActionSchema>

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_TIMEOUT_MS = 300_000
const OUTPUT_MAX_BYTES = 20 * 1024

const INTERPRETERS: Record<ScriptConfig['runtime'], string[]> = {
  bash: ['bash'],
  // `-u`: sin buffer, para que la salida llegue completa aunque el proceso se
  // mate por timeout.
  python: ['python3', '-u'],
}

export interface ScriptActionDeps {
  /** El repo sobre el que corre la tarea del evento. `null` ⇒ no hay dónde
   *  correr y la acción se rechaza. */
  workspaceFor(event: ActionContext['event']): Promise<string | null>
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

function truncate(out: string): string {
  const bytes = Buffer.from(out)
  if (bytes.length <= OUTPUT_MAX_BYTES) return out
  return `${bytes.subarray(0, OUTPUT_MAX_BYTES).toString()}\n[truncated]`
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

    const [bin, ...binArgs] = INTERPRETERS[config.runtime]
    const argv = [
      bin,
      ...binArgs,
      script,
      ...(config.args ?? []).map((a) => interpolate(a, ctx.event)),
    ]

    // Env de allow-list: SÓLO lo declarado, más el PATH mínimo para encontrar
    // el intérprete. Nada del env del daemon.
    const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin' }
    for (const [k, v] of Object.entries(config.env ?? {})) {
      env[k] = interpolate(v, ctx.event)
    }

    const timeoutMs = Math.min(config.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
    const spawn = this.deps.spawn ?? Bun.spawn

    log.info(
      {
        ruleId: ctx.rule.id,
        script,
        runtime: config.runtime,
        envKeys: Object.keys(config.env ?? {}),
      },
      'Corriendo script',
    )

    const proc = spawn(argv, { cwd: workspace, env, stdout: 'pipe', stderr: 'pipe' })
    const timer = setTimeout(() => proc.kill(), timeoutMs)
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      const out = truncate([stdout, stderr].filter(Boolean).join('\n').trim())
      if (code !== 0) {
        return { ok: false, detail: `exit ${code}${out ? `: ${out}` : ''}` }
      }
      return { ok: true, detail: out || 'exit 0' }
    } finally {
      clearTimeout(timer)
    }
  }
}
