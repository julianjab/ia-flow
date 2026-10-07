import { spawn } from 'node:child_process'
import { SchemaTool } from '@ia-flow/agent-engine'
import { z } from 'zod'
import { type BashPolicy, isAllowed, isDenied } from './BashPolicy.js'
import { ghEnv, ghReadOnlyRisk } from './ghReadOnly.js'
import { tokenize } from './tokenize.js'

export const BashRunInput = z.strictObject({
  command: z.string().min(1).describe('Comando + args separados por espacio, ej. "git status"'),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Cuánto dejarlo correr antes de cortarlo, en ms — para algo que sabés que tarda (una suite de tests entera, un build). Sin esto, el default de la tool; nunca más que el máximo que dice su descripción.',
    ),
})
export type BashRunInput = z.infer<typeof BashRunInput>

export interface BashRunToolOptions {
  /** Directorio donde corre el proceso — típicamente el worktree del agente. */
  baseDir: string
  policy: BashPolicy
  /** Cuánto corre un comando si el agente no pide otra cosa. Default 60s. */
  timeoutMs?: number
  /** Lo máximo que el agente puede pedir por comando (`timeoutMs` del input). Default: igual a
   *  `timeoutMs` — sin configurarlo, el agente no puede estirarlo. */
  maxTimeoutMs?: number
  /** Tope de stdout/stderr combinado antes de truncar Y matar el proceso. Default 64KB. */
  maxOutputBytes?: number
  /** Env del proceso hijo. Default: un subset mínimo de `process.env` (ver
   *  `DEFAULT_SAFE_ENV_KEYS`) — NUNCA el entorno completo. Pasá esto explícito si el comando
   *  necesita algo puntual del entorno (una API key, un flag de build). */
  env?: Record<string, string>
  /**
   * Credencial de GitHub para los `git` DE RED que corre el agente (`push`, `fetch`, `pull`,
   * `ls-remote`) — lo que le permite pushear sin que el token esté en disco ni en su entorno. Se
   * pide en cada comando (un installation token vence a la hora) y viaja SÓLO en el argv de ese
   * `git`, como `-c http.https://github.com/.extraHeader`: scopeada a GitHub, así un
   * `git fetch https://otro.host/x` no se la entrega a nadie. Mismo criterio que el `bash_run` de
   * ia-flow, con un cierre más: git pasa sus `-c` a los procesos hijos (`GIT_CONFIG_PARAMETERS`),
   * hooks incluidos, y un repo con `core.hooksPath` versionado (`.husky/`) deja al agente editar
   * el hook que correría con el token. Por eso el comando que lleva la credencial corre SIN hooks
   * (`core.hooksPath=/dev/null`), y los que no son de red (`commit`, con sus hooks) no la reciben.
   *
   * Con esto seteado, además, se rechazan las formas de git que podrían leerla o desviarla (ver
   * `gitCredentialRisk`). Sin esto, `git` corre como siempre, sin credencial.
   *
   * La misma credencial la usa `gh` en sus formas de LECTURA (`gh run view --log-failed`, ver
   * `ghReadOnlyRisk`): va por `GH_TOKEN` en el env de ESE hijo, nunca en el del resto de los
   * comandos, y cualquier otro `gh` se rechaza antes de spawnear.
   */
  gitCredential?: () => Promise<string | undefined>
}

/** El scope de la credencial: git sólo la manda a URLs bajo este prefijo. */
const GITHUB_URL_SCOPE = 'https://github.com/'

/** Los subcomandos de git que hablan con el remoto — los únicos que reciben la credencial. */
const GIT_NETWORK_SUBCOMMANDS = new Set(['push', 'fetch', 'pull', 'ls-remote'])

/**
 * Por qué un `git` NO puede recibir la credencial, o `undefined` si puede. Complementa los
 * chequeos siempre activos de `BashPolicy` (`-c`/`config`/`--config-env`, `--upload-pack`/
 * `--exec`, `rebase -x`, …) con lo que sólo importa cuando hay un token en juego:
 *   - opciones globales antes del subcomando (`-C`, `--git-dir`, `--work-tree`, `--exec-path`,
 *     `--namespace`…): apuntan git a otro repo, cambian de dónde carga sus subcomandos (un
 *     `git-status` escrito antes correría con el header en `GIT_CONFIG_PARAMETERS`) o corren el
 *     índice del subcomando. Ningún flujo normal las necesita.
 *   - `var`: `git var -l` vuelca la config, incluido el header inyectado.
 *   - `--git-dir`/`--work-tree`/`--exec-path` después del subcomando, por las mismas razones.
 */
function gitCredentialRisk(argv: string[]): string | undefined {
  const subcommandIndex = argv.findIndex((token, i) => i > 0 && !token.startsWith('-'))
  const globals = argv.slice(1, subcommandIndex === -1 ? undefined : subcommandIndex)
  if (globals.length > 0) return `opciones globales antes del subcomando (${globals.join(' ')})`
  if (argv[subcommandIndex] === 'var') return 'git var (vuelca la config)'
  const leaking = argv.find(
    (token) =>
      token.startsWith('--git-dir') ||
      token.startsWith('--work-tree') ||
      token.startsWith('--exec-path'),
  )
  return leaking ? `${leaking} (desvía git fuera del worktree)` : undefined
}

const DEFAULT_TIMEOUT_MS = 60_000

type TimeoutOptions = Pick<BashRunToolOptions, 'timeoutMs' | 'maxTimeoutMs'>

function timeoutLimits(options: TimeoutOptions): { base: number; max: number } {
  const base = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return { base, max: Math.max(base, options.maxTimeoutMs ?? base) }
}

const seconds = (ms: number) => `${Math.round(ms / 1000)} s`

/** Lo que el modelo lee sobre el tiempo: el default y, si puede estirarlo, hasta cuánto. Va al
 *  final de la descripción de la tool (y de quien la envuelva, ej. `workspaceAction`). */
export function timeoutNote(options: TimeoutOptions): string {
  const { base, max } = timeoutLimits(options)
  return max > base
    ? `Un comando se corta a los ${seconds(base)}; para algo largo (una suite de tests entera) pedí más con \`timeoutMs\`, hasta ${seconds(max)}.`
    : `Un comando se corta a los ${seconds(base)}.`
}
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024

/** Lo mínimo para que un binario común (git, node, un linter) arranque sin romperse — nunca
 *  tokens/keys. Heredar `process.env` ENTERO (el default de `child_process.spawn`) le pasaría
 *  al proceso todo lo que el host tenga seteado (GITHUB_TOKEN, ANTHROPIC_API_KEY, credenciales
 *  de Slack, lo que sea) — con un solo intérprete que se cuele por el deny-list (`awk`, `sed`,
 *  uno que no esté en la lista todavía), esos valores quedan a un `ENVIRON`/`getenv` de
 *  distancia. Un caller que necesite algo puntual del entorno lo pasa explícito por `env`. */
const DEFAULT_SAFE_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TZ', 'USER', 'SHELL']

function buildSafeEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of DEFAULT_SAFE_ENV_KEYS) {
    const value = process.env[key]
    if (value != null) env[key] = value
  }
  return env
}

/** Acumula chunks de un stream con un tope de BYTES real (no de caracteres — un tope por
 *  caracteres deja pasar de largo con UTF-8 multibyte) y deja de acumular apenas lo alcanza,
 *  en vez de truncar recién al final: sin esto, un comando como `yes` o un `cat` de un archivo
 *  gigante puede llenar la memoria del proceso mucho antes de que `close` llegue. */
class BoundedCollector {
  private readonly chunks: Buffer[] = []
  private bytes = 0
  truncated = false

  push(chunk: Buffer, maxBytes: number): void {
    if (this.truncated) return
    const remaining = maxBytes - this.bytes
    if (remaining <= 0) {
      this.truncated = true
      return
    }
    if (chunk.length > remaining) {
      this.chunks.push(chunk.subarray(0, remaining))
      this.bytes += remaining
      this.truncated = true
      return
    }
    this.chunks.push(chunk)
    this.bytes += chunk.length
  }

  toString(): string {
    const text = Buffer.concat(this.chunks).toString('utf-8')
    return this.truncated ? `${text}\n[truncado — salida supera el tope configurado]` : text
  }
}

/**
 * Única tool del paquete — a diferencia de `github-tools`/`fs-tools` no hay una jerarquía de
 * clases de dominio que compartir (sólo existe ESTA tool), así que extiende `SchemaTool` directo,
 * sin base intermedia.
 */
export class BashRunTool extends SchemaTool<typeof BashRunInput> {
  readonly name = 'bash_run'
  readonly description: string
  readonly input = BashRunInput

  constructor(private readonly options: BashRunToolOptions) {
    super()
    this.description = `Ejecuta un comando SIN shell (sin pipes, redirecciones ni expansión) dentro de ${options.baseDir} — usa comillas para args con espacios. ${timeoutNote(options)}`
  }

  /** Cuánto dejar correr ESTE comando: lo que pidió el agente, sin pasar el máximo. */
  private timeoutFor(requested: number | undefined): number {
    const { base, max } = timeoutLimits(this.options)
    return Math.min(requested ?? base, max)
  }

  /**
   * El argv a spawnear: el del agente tal cual, salvo un `git` con `gitCredential` configurado,
   * que recibe el header de GitHub justo después de `git` (en git gana el último `-c`, pero el
   * agente no puede pasar `-c`: lo rechaza la policy siempre). Sin token disponible corre igual,
   * sin credencial — git dirá "could not read Username" y el agente lo lee.
   */
  private async withGitCredential(argv: string[], command: string): Promise<string[]> {
    if (argv[0] !== 'git' || !this.options.gitCredential) return argv
    const risk = gitCredentialRisk(argv)
    if (risk) throw new Error(`bash_run: git con credencial no admite ${risk}: "${command}"`)
    const subcommand = argv.find((token, i) => i > 0 && !token.startsWith('-'))
    if (!subcommand || !GIT_NETWORK_SUBCOMMANDS.has(subcommand)) return argv
    const token = await this.options.gitCredential().catch(() => undefined)
    if (!token) return argv
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
    return [
      'git',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      `http.${GITHUB_URL_SCOPE}.extraHeader=AUTHORIZATION: basic ${basic}`,
      ...argv.slice(1),
    ]
  }

  /** El env del hijo: el base, más `GH_TOKEN` si es un `gh` de lectura permitido. */
  private async withGhCredential(
    policyArgv: string[],
    command: string,
  ): Promise<Record<string, string>> {
    const base = this.options.env ?? buildSafeEnv()
    if (policyArgv[0] !== 'gh' || !this.options.gitCredential) return base
    const risk = ghReadOnlyRisk(policyArgv)
    if (risk) throw new Error(`bash_run: gh con credencial no admite ${risk}: "${command}"`)
    const token = await this.options.gitCredential().catch(() => undefined)
    return token ? ghEnv(base, token) : base
  }

  protected async execute(input: BashRunInput): Promise<string> {
    const argv = tokenize(input.command)
    if (argv.length === 0) {
      throw new Error('bash_run: comando vacío')
    }
    // Sin esto, un path calificado (`/bin/rm`, `./rm`, `bin/curl`) se salta CUALQUIER regla de
    // deny que compare contra el nombre pelado ('rm', 'curl', 'bash') — la policy entera es
    // texto plano contra `argv[0]`, no resuelve símlinks ni PATH. bash_run sólo corre nombres
    // de binario resueltos por PATH, nunca un path explícito.
    if (argv[0].includes('/')) {
      throw new Error(
        `bash_run: el comando no puede incluir un path ("${argv[0]}") — usá el nombre del binario resuelto por PATH`,
      )
    }

    // PATH resuelve el nombre del binario SIN distinguir mayúsculas en macOS/Windows (APFS/NTFS
    // default) — "Bash"/"PYTHON3" encuentran exactamente los mismos binarios que "bash"/
    // "python3". Sin normalizar, toda la policy (patrones + los chequeos dedicados de git) se
    // esquiva con sólo cambiar la capitalización del comando. El resto de los tokens (args) no
    // pasan por una resolución de filesystem, así que sólo `argv[0]` necesita normalizarse.
    const policyArgv = [argv[0].toLowerCase(), ...argv.slice(1)]

    const deniedBy = isDenied(policyArgv, this.options.policy)
    if (deniedBy) {
      throw new Error(
        `bash_run: comando denegado por la policy (matchea "${deniedBy}"): "${input.command}"`,
      )
    }
    if (!isAllowed(policyArgv, this.options.policy)) {
      throw new Error(`bash_run: comando no está en la allowlist: "${input.command}"`)
    }

    const spawnArgv = await this.withGitCredential(argv, input.command)
    const env = await this.withGhCredential(policyArgv, input.command)
    const timeoutMs = this.timeoutFor(input.timeoutMs)
    const { max: maxTimeoutMs } = timeoutLimits(this.options)
    const maxOutputBytes = this.options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES

    return new Promise<string>((resolve, reject) => {
      // `detached: true` en POSIX hace que el child sea el LÍDER de su propio grupo de
      // procesos — es lo que permite matar el árbol entero (`process.kill(-pid, ...)`), no
      // sólo el proceso directo. Sin esto, un timeout mata a `npm test` pero deja corriendo a
      // los procesos que `npm test` lanzó, que quedan con stdout/stderr abiertos — `close`
      // nunca llega y la Promise queda colgada para siempre.
      const child = spawn(spawnArgv[0] as string, spawnArgv.slice(1), {
        cwd: this.options.baseDir,
        shell: false,
        detached: process.platform !== 'win32',
        env,
        // Sin esto, stdin queda como un pipe abierto que nadie escribe ni cierra — cualquier
        // comando que lea de stdin (`git commit` sin `-m`, que abre un editor; `cat`/`tee`/`grep`
        // sin archivo; un prompt interactivo) se cuelga hasta `timeoutMs`, y el modelo sólo ve
        // "señal SIGKILL" sin ninguna pista de por qué. `bash_run` no tiene ningún mecanismo para
        // mandarle stdin a un comando, así que no hay razón para dejarlo abierto.
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      const stdout = new BoundedCollector()
      const stderr = new BoundedCollector()
      let settled = false
      let timedOut = false

      const killGroup = () => {
        if (child.pid == null) return
        try {
          if (process.platform === 'win32') {
            child.kill('SIGKILL')
          } else {
            process.kill(-child.pid, 'SIGKILL')
          }
        } catch {
          // el proceso (o el grupo) ya puede haber terminado solo entre el chequeo y el kill —
          // no es un error real, `close` va a llegar igual.
        }
      }

      const timeoutTimer = setTimeout(() => {
        timedOut = true
        killGroup()
      }, timeoutMs)

      child.stdout.on('data', (chunk: Buffer) => {
        stdout.push(chunk, maxOutputBytes)
        if (stdout.truncated) killGroup()
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr.push(chunk, maxOutputBytes)
        if (stderr.truncated) killGroup()
      })
      child.on('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timeoutTimer)
        reject(err)
      })
      child.on('close', (code, signal) => {
        if (settled) return
        settled = true
        clearTimeout(timeoutTimer)
        // Un corte por tiempo dice que fue por tiempo — sin esto el modelo sólo veía "señal
        // SIGKILL" y no sabía si reintentar, achicar el comando o pedir más tiempo.
        const status = timedOut
          ? `timeout: se cortó a los ${seconds(timeoutMs)}${timeoutMs < maxTimeoutMs ? ` (podés pedir hasta ${seconds(maxTimeoutMs)} con timeoutMs)` : ' (es el máximo: corré una parte más chica)'}`
          : signal
            ? `señal ${signal}`
            : `exit ${code}`
        resolve(JSON.stringify({ status, stdout: stdout.toString(), stderr: stderr.toString() }))
      })
    })
  }
}
