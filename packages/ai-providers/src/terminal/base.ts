// Shared logic for terminal-based Claude providers (iTerm2 and tmux)
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { type McpServers, McpServersSchema } from '@ia-flow/shared'
import { z } from 'zod'
import { writeMcpConfigFile } from '../claude-cli/mcp-config.js'
import type { LoadProviderConfig, ProviderInput, WorktreePathResolver } from '../contract.js'

// Per-agent providerConfig shape for terminal providers. Kept private to
// this file so shared/ stays agnostic. Strict → extra fields (e.g.
// anthropic-api specific ones) are rejected at runtime.
const TerminalAgentConfigSchema = z
  .object({
    model: z.string().optional(),
    dangerouslySkipPermissions: z.boolean().optional(),
    mcpServers: McpServersSchema.optional(),
  })
  .strict()

function parseTerminalAgentConfig(
  raw: unknown,
): z.infer<typeof TerminalAgentConfigSchema> | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = TerminalAgentConfigSchema.safeParse(raw)
  return r.success ? r.data : undefined
}

// Terminal-launched Claude sessions (iterm/tmux) don't get tools via the
// Anthropic API `tools:` param — they run the `claude` CLI which has its own
// tool-discovery layer. Our agent-declared tools reach it the same way any
// external MCP server does: a synthetic `ia-flow-tools` entry (see
// buildClaudeCommand below) pointing `--mcp-config` at the daemon's own
// /api/mcp endpoint — the CLI calls it client-side, same wire format as a
// catalog MCP server, no curl-recipe text in the system prompt.

// Terminal sessions run fully unattended — no human is watching the tmux/
// iTerm pane, so a clarifying question is a dead end, not a pause. This gets
// appended to every terminal run's system prompt (independent of whether the
// agent has tools) — same rationale as the git-context block: behavior that
// depends on "which provider is this" shouldn't live in agent.prompt (DB),
// where it would drift between agents or get silently dropped by whoever
// edits the prompt next.
const UNATTENDED_SESSION_NOTE = [
  '## Sesión desatendida',
  '',
  'Esta sesión corre sin supervisión humana: nadie va a leer una pregunta ni',
  'responderla. No preguntes ni esperes confirmación — tomá la mejor decisión',
  'con el contexto que tenés y seguí. Antes de terminar, dejá TODO publicado',
  '(commit, push, PR, comentario/estado del issue, lo que el flujo de trabajo',
  'requiera) — nada de lo que hiciste localmente debe quedar sin reportar.',
  'Cerrá siempre el run llamando a `complete_task` o `fail_task`.',
].join('\n')

export const pexec = promisify(execFile)

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50) || 'task'
  )
}

// ─── Resolve a valid git base branch ─────────────────────────────────────

export async function resolveBaseBranch(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await pexec('git', ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      timeout: 5_000,
    })
    const branch = stdout.trim()
    if (branch && branch !== 'HEAD') return branch
    for (const candidate of ['main', 'master', 'develop']) {
      try {
        await pexec('git', ['-C', repoPath, 'rev-parse', '--verify', candidate], { timeout: 3_000 })
        return candidate
      } catch {
        /* not found */
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Mismo criterio que WorkspaceManager.isWorktreeSafeToRemove
 * (packages/agent-engine/src/WorkspaceManager.ts), reimplementado con pexec
 * en vez de ShellRunner para mantener el patrón del resto de este archivo —
 * los providers terminal (tmux/iterm) no pasan por WorkspaceManager por
 * diseño (ver el comentario en WorkspaceManager.needsWorkspace).
 *
 * Devuelve true solo si:
 *   1. No hay cambios sin commitear (`git status --porcelain` vacío).
 *   2. No hay commits locales por delante de `origin/<branch>` (o de
 *      `origin/HEAD` si la branch remota no existe).
 *
 * Best-effort: cualquier falla de git (HEAD detached, sin remote, error de
 * red) devuelve false — el caller trata eso como "no seguro" y no borra
 * nada.
 */
async function isWorktreeSafeToRemove(worktreePath: string, branch: string): Promise<boolean> {
  try {
    const status = await pexec('git', ['-C', worktreePath, 'status', '--porcelain'], {
      timeout: 5_000,
    })
    if (status.stdout.trim().length > 0) return false
  } catch {
    return false
  }

  try {
    await pexec(
      'git',
      ['-C', worktreePath, 'ls-remote', '--exit-code', 'origin', `refs/heads/${branch}`],
      { timeout: 10_000 },
    )
  } catch {
    // Remote branch absent — check if HEAD is beyond origin/HEAD (base branch).
    try {
      const log = await pexec(
        'git',
        ['-C', worktreePath, 'log', '--oneline', 'origin/HEAD..HEAD'],
        { timeout: 5_000 },
      )
      return log.stdout.trim().length === 0
    } catch {
      return false
    }
  }

  // Remote branch exists — check for commits ahead of it.
  try {
    const ahead = await pexec(
      'git',
      ['-C', worktreePath, 'log', '--oneline', `origin/${branch}..HEAD`],
      { timeout: 5_000 },
    )
    return ahead.stdout.trim().length === 0
  } catch {
    return false
  }
}

/**
 * Materializa el worktree de la task, idempotente. Misma cadena de fallbacks
 * que usaba el hook WorktreeCreate, ahora en TS para que el resultado sea
 * observable (lanza con el stderr de git) en vez de morir dentro del terminal:
 *
 *   1) reusar la branch (local o ya creada por un run previo)
 *   2) crearla desde `origin/<branch>` (linked branch de GitHub)
 *   3) crearla desde `origin/<base>`
 *   4) crearla desde `<base>` local (repo sin remote / sin red)
 *
 * No-op si el worktree ya está en disco: `git worktree add` fallaría por path
 * ocupado y el `cd` posterior funciona igual.
 */
export async function ensureWorktree(opts: {
  repoPath: string
  worktreePath: string
  branch: string
  baseBranch: string
}): Promise<void> {
  const { repoPath, worktreePath, branch, baseBranch } = opts

  // `git worktree list` sigue listando worktrees cuyo directorio ya no está
  // (quedan *prunable*). Sin este prune daríamos por bueno un registro stale,
  // el comando quedaría `cd "<path inexistente>" && claude …`, el `&&` cortaría
  // y la sesión nunca arrancaría — sin error visible en la UI. Camino muy
  // probable: es justo lo que queda tras seguir el `rm -rf` que sugiere el
  // throw de más abajo.
  await pexec('git', ['-C', repoPath, 'worktree', 'prune'], { timeout: 10_000 }).catch(() => {})

  if ((await worktreeExists(repoPath, worktreePath)) && existsSync(worktreePath)) return

  // La branch ya está checkouteada en OTRO worktree — típicamente uno legacy
  // nombrado por el taskId, previo a `worktreeNameFor`. Los 4 fallbacks de
  // abajo fallarían todos ("is already checked out" / "branch already exists")
  // con un volcado de git que no menciona al culpable.
  const owner = await worktreeForBranch(repoPath, branch)
  if (owner && owner !== worktreePath) {
    throw new Error(
      `La branch "${branch}" ya está checkouteada en el worktree "${owner}", ` +
        `distinto al que esta task usa ahora ("${worktreePath}"). ` +
        `Removelo para reciclarla: git -C "${repoPath}" worktree remove --force "${owner}"`,
    )
  }

  // Directorio ocupado pero NO registrado como worktree de ESTE repo: resto de
  // un clone anterior o de otro checkout. `git worktree add` fallaría con un
  // "already exists" que no dice nada; no lo borramos por si tiene trabajo.
  if (existsSync(worktreePath)) {
    throw new Error(
      `El directorio "${worktreePath}" existe pero no es un worktree de "${repoPath}". ` +
        `Revisalo y borralo para reciclarlo: rm -rf "${worktreePath}"`,
    )
  }

  await pexec('git', ['-C', repoPath, 'fetch', 'origin'], { timeout: 30_000 }).catch(() => {})

  const attempts: string[][] = [
    ['worktree', 'add', worktreePath, branch],
    ['worktree', 'add', '-b', branch, worktreePath, `origin/${branch}`],
    ['worktree', 'add', '-b', branch, worktreePath, `origin/${baseBranch}`],
    ['worktree', 'add', '-b', branch, worktreePath, baseBranch],
  ]
  const errors: string[] = []
  for (const args of attempts) {
    try {
      await pexec('git', ['-C', repoPath, ...args], { timeout: 30_000 })
      return
    } catch (err) {
      errors.push(`$ git ${args.join(' ')}\n${(err as { stderr?: string }).stderr ?? String(err)}`)
    }
  }
  throw new Error(
    `No pude crear el worktree para la branch "${branch}" en "${worktreePath}":\n${errors.join('\n')}`,
  )
}

/** Path del worktree que tiene `branch` checkouteada, si alguno. */
async function worktreeForBranch(repoPath: string, branch: string): Promise<string | undefined> {
  let stdout: string
  try {
    const r = await pexec('git', ['-C', repoPath, 'worktree', 'list', '--porcelain'], {
      timeout: 5_000,
    })
    stdout = r.stdout
  } catch {
    return undefined
  }
  for (const block of stdout.split(/\n\n+/)) {
    const ref = block.match(/^branch\s+refs\/heads\/(.+)$/m)?.[1]?.trim()
    if (ref === branch) return block.match(/^worktree (.+)$/m)?.[1]?.trim()
  }
  return undefined
}

/** True si `git worktree list` ya registra ese path. Compara por sufijo de
 *  path real: en macOS `/tmp` es symlink a `/private/tmp`, así que git
 *  reporta la ruta resuelta y una comparación literal nunca matchea. */
async function worktreeExists(repoPath: string, worktreePath: string): Promise<boolean> {
  try {
    const { stdout } = await pexec('git', ['-C', repoPath, 'worktree', 'list', '--porcelain'], {
      timeout: 5_000,
    })
    return stdout
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .some((l) => {
        const p = l.slice('worktree '.length).trim()
        return p === worktreePath || p.endsWith(worktreePath) || worktreePath.endsWith(p)
      })
  } catch {
    return false
  }
}

/**
 * Falla rápido si el repo ya tiene un worktree registrado para esta task con
 * una branch distinta a la esperada. Motivación: el hook WorktreeCreate NO
 * puede reconciliar branches en un worktree existente (git rechaza reagregar
 * el path); dejarlo llegar al hook produce un `exit 1` dentro del terminal
 * que la UI no ve. Bloquear acá permite que el error viaje por el flujo
 * normal de error del provider (executionLog.errorMsg → banner rojo).
 *
 * Cuando la branch no coincide, en vez de lanzar directo primero chequea
 * `isWorktreeSafeToRemove` (mismo criterio que ya usa WorkspaceManager para
 * el provider anthropic-api): si no hay cambios sin commitear ni commits sin
 * pushear, borra el worktree y la branch obsoletos (best-effort, ignora
 * fallos de la limpieza en sí) y resuelve sin lanzar — el hook WorktreeCreate
 * recrea el worktree sobre `expectedBranch` en el próximo intento. Si hay
 * trabajo en riesgo, o el chequeo de seguridad falla, se mantiene el `throw`
 * con el mensaje procesable para borrado manual.
 *
 * No-op cuando: no existe worktree para la task, o ya está en la branch
 * esperada, o el comando `git worktree list` falla (best-effort — no
 * queremos bloquear runs por un git desconfigurado; el hook se encargará
 * después).
 */
export async function assertWorktreeBranchMatches(
  repoPath: string,
  worktreeName: string,
  expectedBranch: string,
): Promise<void> {
  let stdout: string
  try {
    const r = await pexec('git', ['-C', repoPath, 'worktree', 'list', '--porcelain'], {
      timeout: 5_000,
    })
    stdout = r.stdout
  } catch {
    return
  }
  // Parseo mínimo: bloques separados por línea vacía, cada bloque tiene
  // `worktree <path>` y opcionalmente `branch refs/heads/<name>`.
  const suffix = `/.worktrees/${worktreeName}`
  for (const block of stdout.split(/\n\n+/)) {
    const pathLine = block.match(/^worktree (.+)$/m)?.[1]?.trim()
    if (!pathLine || !pathLine.endsWith(suffix)) continue
    const branchRef = block.match(/^branch\s+refs\/heads\/(.+)$/m)?.[1]?.trim()
    if (branchRef && branchRef !== expectedBranch) {
      const safeToRemove = await isWorktreeSafeToRemove(pathLine, branchRef).catch(() => false)
      if (safeToRemove) {
        await pexec('git', ['-C', repoPath, 'worktree', 'remove', '--force', pathLine], {
          timeout: 10_000,
        }).catch(() => {})
        await pexec('git', ['-C', repoPath, 'branch', '-D', branchRef], {
          timeout: 5_000,
        }).catch(() => {})
        return
      }
      throw new Error(
        `El worktree ${worktreeName} ya existe en "${pathLine}" con branch "${branchRef}" ` +
          `pero se esperaba "${expectedBranch}". ` +
          `Elimínalo manualmente para reciclarlo: ` +
          `git -C "${repoPath}" worktree remove --force "${pathLine}"` +
          (branchRef ? ` && git -C "${repoPath}" branch -D "${branchRef}"` : ''),
      )
    }
    return
  }
}

// ─── Write prompt to temp file and build claude command ──────────────────
//
// writeMcpConfigFile (el archivo --mcp-config) vive en ../claude-cli/mcp-config.js
// — es pura traducción de forma + escritura a disco, sin nada específico de
// sesión de terminal, así que también lo usa claude-print (headless).

/**
 * Escribe un settings.json temporal por-run consumido con `claude --settings`.
 * Puede combinar `env` (evita exportarlas en el shell del terminal, no quedan
 * en el buffer visible) y hooks (por ahora, WorktreeCreate en workflow=worktree).
 *
 * Claude Code hace merge por key top-level entre este archivo y los settings
 * del user/project — no reemplaza `hooks`/`env` existentes salvo por keys con
 * el mismo nombre.
 */
// Path absoluto (resuelto en tiempo de import) al script forwarder que Claude
// Code ejecuta para cada hook. Vive junto a este archivo para que el script
// viaje con el server sin depender del cwd donde corra `claude`.
const HOOK_TOOL_USE_PATH = new URL('./hook-tool-use.ts', import.meta.url).pathname

// Todos los hooks que registramos por-run. El forwarder recibe el nombre del
// hook como argv[2] y arma el body /api/hook-events correspondiente. Ver
// hook-tool-use.ts para el mapping evento → shape.
const FORWARDED_HOOKS = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'Stop',
  'SubagentStop',
  'SessionStart',
] as const

function buildForwardedHooks() {
  const entry = (name: string) => ({
    type: 'command' as const,
    command: `bun ${HOOK_TOOL_USE_PATH} ${name}`,
  })
  // ToolUse hooks aceptan matcher; el resto no lo requiere. Mantenemos
  // matcher '.*' para PreToolUse/PostToolUse por compat con el shape previo.
  return {
    PreToolUse: [{ matcher: '.*', hooks: [entry('PreToolUse')] }],
    PostToolUse: [{ matcher: '.*', hooks: [entry('PostToolUse')] }],
    UserPromptSubmit: [{ hooks: [entry('UserPromptSubmit')] }],
    Stop: [{ hooks: [entry('Stop')] }],
    SubagentStop: [{ hooks: [entry('SubagentStop')] }],
    SessionStart: [{ hooks: [entry('SessionStart')] }],
  }
}

async function writeRunSettings(opts: {
  env?: Record<string, string>
  hookToolUse?: boolean
}): Promise<string | undefined> {
  const settings: Record<string, unknown> = {}
  if (opts.env && Object.keys(opts.env).length > 0) settings.env = opts.env
  const hooks: Record<string, unknown> = {}
  if (opts.hookToolUse) Object.assign(hooks, buildForwardedHooks())
  if (Object.keys(hooks).length > 0) settings.hooks = hooks
  if (Object.keys(settings).length === 0) return undefined

  const path = `/tmp/iaflow-settings-${Date.now()}-${randomUUID().slice(0, 8)}.json`
  // Puede contener secretos (OAuth token, API keys de env) — mode en la
  // apertura, no un chmod posterior, para no dejar una ventana en la que el
  // archivo es legible por otros usuarios del sistema (mismo criterio que
  // writeMcpConfigFile en ../claude-cli/mcp-config.ts).
  await writeFile(path, JSON.stringify(settings, null, 2), { mode: 0o600 })
  return path
}

export interface TerminalBaseDeps {
  loadProviderConfig: LoadProviderConfig
  worktree: WorktreePathResolver
}

/** Factory: builds the `buildClaudeCommand` closure with its two injected
 *  dependencies bound, so tmux/iterm providers don't each need to thread
 *  them through by hand. */
export function createTerminalBase(deps: TerminalBaseDeps) {
  const { loadProviderConfig, worktree } = deps

  async function buildClaudeCommand(
    input: ProviderInput,
    providerId: 'tmux-claude' | 'iterm-claude' = 'tmux-claude',
  ): Promise<{
    cmd: string
    promptFile: string
    mcpConfigFile?: string
    /** Settings.json temporal por-run — puede incluir `env` (siempre, si hay)
     *  y/o el hook WorktreeCreate (solo cuando workflow=worktree). Se pasa via
     *  `claude --settings`. El caller puede loguearlo o borrarlo post-run. */
    settingsFile?: string
    /** File con la nota de "sesión desatendida" pasada via
     *  `--append-system-prompt-file`. Siempre presente. */
    syspromptFile: string
  }> {
    const promptFile = `/tmp/iaflow-prompt-${Date.now()}.txt`
    // Branch resolution: preferimos `input.branch` (linked branch de GitHub o
    // valor auto-generado por el engine) sobre el fallback determinístico
    // `task/<taskId>`. `slugify` sigue exportada — el tmux provider la usa para
    // nombrar sesiones.
    const branchName = input.branch?.trim() || `task/${input.taskId}`

    const config = await loadProviderConfig()
    const termDefaults =
      providerId === 'iterm-claude' ? (config.itermClaude ?? {}) : (config.tmuxClaude ?? {})

    // Per-agent override — validated against this provider's private schema.
    const pc = parseTerminalAgentConfig(input.providerConfig)

    const model = pc?.model ?? termDefaults.model
    const dsp = pc?.dangerouslySkipPermissions ?? termDefaults.dangerouslySkipPermissions
    const resolvedMcpServers = pc?.mcpServers ?? termDefaults.mcpServers

    let claudeFlags = ''
    if (model) claudeFlags += ` --model ${model}`
    if (dsp) claudeFlags += ' --dangerously-skip-permissions'

    const daemonUrl = `http://localhost:${Bun.env.IA_FLOW_SERVER_PORT ?? Bun.env.PORT ?? '3001'}`

    // Agent-declared tools reach the CLI as one more MCP server pointing at
    // the daemon's own /api/mcp endpoint — same wire format as any catalog
    // entry (github-mcp, etc), instead of the old curl-recipe appendix. The
    // agent's tool names travel in the URL (`?tools=a,b,c`) since MCP's
    // `tools/list` has no per-call scoping argument.
    const mcpServers: McpServers = { ...(resolvedMcpServers ?? {}) }
    if (input.tools?.length) {
      mcpServers['ia-flow-tools'] = {
        type: 'http',
        url: `${daemonUrl}/api/mcp?tools=${encodeURIComponent(input.tools.join(','))}`,
      }
    }

    let mcpConfigFile: string | undefined
    if (Object.keys(mcpServers).length > 0) {
      mcpConfigFile = await writeMcpConfigFile(mcpServers)
      claudeFlags += ` --mcp-config "${mcpConfigFile}"`
    }

    const syspromptFile = `/tmp/iaflow-sysprompt-${Date.now()}-${randomUUID().slice(0, 8)}.md`
    await writeFile(syspromptFile, UNATTENDED_SESSION_NOTE, { mode: 0o600 })
    claudeFlags += ` --append-system-prompt-file "${syspromptFile}"`

    // Env vars del terminal viven en settings.json (`env:`) — no se exportan en
    // el shell, evita filtrarlas al buffer visible y unifica la convención con
    // el hook WorktreeCreate (ambos comparten el mismo archivo `--settings`).
    const runEnv: Record<string, string> = { ...(termDefaults.env ?? {}) }
    if (Bun.env.CLAUDE_CODE_OAUTH_TOKEN && !runEnv.CLAUDE_CODE_OAUTH_TOKEN) {
      runEnv.CLAUDE_CODE_OAUTH_TOKEN = Bun.env.CLAUDE_CODE_OAUTH_TOKEN
    }
    // Consumed by `terminal/hook-tool-use.ts` (registrado como
    // PostToolUse en el settings.json per-run): el hook POSTea
    // tool_use/tool_result a $IA_FLOW_SERVER_URL/api/hook-events tagged con
    // $IA_FLOW_RUN_ID para que el drawer de ejecuciones renderice tarjetas de
    // tool.call/tool.result en runs async (tmux/iterm) igual que el provider
    // anthropic-api. Sin IA_FLOW_RUN_ID el hook es no-op.
    if (input.runId) {
      runEnv.IA_FLOW_RUN_ID = input.runId
      runEnv.IA_FLOW_SERVER_URL = daemonUrl
    }

    // El texto "git context" (branch, worktree, workflow) lo inyecta el
    // orquestador via `buildGitContext` para que ambos providers reciban el
    // mismo bloque. Acá solo elegimos el shell wrapper que aplica el workflow.
    //
    // workflow=worktree: ia-flow materializa el worktree ACÁ (git plano) y
    // entra con `cd`. Deliberadamente NO pasamos `--worktree`:
    //
    //   • Ese flag dispara el evento WorktreeCreate, y los hooks de ese evento
    //     se mergean entre TODAS las fuentes de settings (user, project y el
    //     `--settings` per-run). Un WorktreeCreate global en la máquina del
    //     usuario corre junto al nuestro y su stdout puede ganar como cwd de la
    //     sesión: quedan DOS worktrees para la misma task — el nuestro, sobre
    //     `input.branch`, huérfano; y el del otro hook, con una branch que
    //     ia-flow no eligió ni conoce (ver historial de este archivo).
    //   • Sin el flag no hay evento, no hay merge de hooks y no hay ambigüedad:
    //     el path y la branch los decide ia-flow, igual en cualquier máquina.
    //
    // El nombre del directorio es legible (`task-<issueNumber>`), no el id
    // opaco del source — ver `worktreeNameFor` en @ia-flow/agent-engine.
    let inlineBranchWrapper = ''
    let cwdPrefix = ''
    if (input.step === 'implement' && input.cwd) {
      const workflow = input.workflow ?? 'branch'
      if (workflow === 'worktree') {
        const baseBranch = await resolveBaseBranch(input.cwd)
        if (!baseBranch) {
          // Degradar en silencio acá sería peor que fallar: `buildGitContext`
          // ya le afirmó al agente "estás dentro del worktree <path>, pusheá
          // <branch>", así que la sesión arrancaría en el clone real y
          // commitearía sobre la branch actual creyendo estar aislada.
          throw new Error(
            `No pude resolver la base branch de "${input.cwd}" (¿HEAD detached?); ` +
              `workflow=worktree necesita una para crear el worktree de la task.`,
          )
        }
        const wtName = worktree.worktreeNameFor({
          id: input.taskId,
          issueNumber: input.issueNumber,
          title: input.taskTitle,
        })
        const wtPath = worktree.worktreePathFor(input.cwd, wtName)
        // Precheck: si ya existe un worktree para esta task con OTRA branch
        // (típicamente naming legacy previo a un rename), falla acá con un
        // mensaje claro. El error se propaga por provider.run →
        // AgentOrchestrator → executionLog.errorMsg → banner.
        await assertWorktreeBranchMatches(input.cwd, wtName, branchName)
        await ensureWorktree({
          repoPath: input.cwd,
          worktreePath: wtPath,
          branch: branchName,
          baseBranch,
        })
        cwdPrefix = `cd "${wtPath}" && `
      } else if (workflow !== 'main') {
        // 'branch' (default): checkout in-place.
        const baseBranch = await resolveBaseBranch(input.cwd)
        if (baseBranch) {
          inlineBranchWrapper = `git checkout -b ${branchName} 2>/dev/null || git checkout ${branchName} && `
        }
      }
    }

    const settingsFile = await writeRunSettings({
      env: runEnv,
      hookToolUse: Boolean(input.runId),
    })
    if (settingsFile) claudeFlags = ` --settings "${settingsFile}"${claudeFlags}`

    // El user prompt es exclusivamente input.prompt (agent.prompt de la DB,
    // resuelto por el orquestador + gitContext prepended). Las tools ya
    // viajan por --mcp-config, no contaminan el prompt.
    await Bun.write(promptFile, input.prompt)

    // Login shells (tmux `$SHELL -lc`, new iTerm tabs) re-source ~/.zshrc /
    // ~/.zprofile, which typically re-exports ANTHROPIC_API_KEY. Unset it
    // right before `claude` runs so el OAuth token (inyectado via settings.env)
    // gane sin conflicto.
    const cmd = `unset ANTHROPIC_API_KEY; ${cwdPrefix}${inlineBranchWrapper}claude${claudeFlags} < "${promptFile}"`

    return { cmd, promptFile, mcpConfigFile, settingsFile, syspromptFile }
  }

  return { buildClaudeCommand }
}
