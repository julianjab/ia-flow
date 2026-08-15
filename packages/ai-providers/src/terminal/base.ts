// Shared logic for terminal-based Claude providers (iTerm2 and tmux)
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod } from 'node:fs/promises'
import { promisify } from 'node:util'
import { type McpServers, McpServersSchema } from '@ia-flow/shared'
import { z } from 'zod'
import type {
  LoadProviderConfig,
  ProviderInput,
  ToolExecutionPort,
  WorktreePathResolver,
} from '../contract.js'

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
// tool-discovery layer. Our agent-declared tools live behind
// POST /api/tools/:name; the rendering (name + description + curl block)
// lives behind `toolExecution.buildToolInstructions` so both this appendix
// and any future entry point share one canonical shape.

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
 * Falla rápido si el repo ya tiene un worktree registrado para esta task con
 * una branch distinta a la esperada. Motivación: el hook WorktreeCreate NO
 * puede reconciliar branches en un worktree existente (git rechaza reagregar
 * el path); dejarlo llegar al hook produce un `exit 1` dentro del terminal
 * que la UI no ve. Bloquear acá permite que el error viaje por el flujo
 * normal de error del provider (executionLog.errorMsg → banner rojo).
 *
 * No-op cuando: no existe worktree para la task, o ya está en la branch
 * esperada, o el comando git falla (best-effort — no queremos bloquear runs
 * por un git desconfigurado; el hook se encargará después).
 */
export async function assertWorktreeBranchMatches(
  repoPath: string,
  taskId: string,
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
  const suffix = `/.worktrees/${taskId}`
  for (const block of stdout.split(/\n\n+/)) {
    const pathLine = block.match(/^worktree (.+)$/m)?.[1]?.trim()
    if (!pathLine || !pathLine.endsWith(suffix)) continue
    const branchRef = block.match(/^branch\s+refs\/heads\/(.+)$/m)?.[1]?.trim()
    if (branchRef && branchRef !== expectedBranch) {
      throw new Error(
        `Worktree para la task ${taskId} ya existe en "${pathLine}" con branch "${branchRef}" ` +
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

// Claude CLI's `.mcpServers` accepts http entries with `headers` but not the
// ia-flow-specific `authorizationToken`. Translate so a single seed shape works
// for both the Anthropic API (authorization_token) and the CLI (Bearer header).
function toCliMcpServers(servers: McpServers): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, srv] of Object.entries(servers)) {
    if (!('url' in srv)) {
      out[name] = srv
      continue
    }
    const { authorizationToken, headers, ...rest } = srv
    const mergedHeaders = { ...(headers ?? {}) }
    if (authorizationToken && !mergedHeaders.Authorization) {
      mergedHeaders.Authorization = `Bearer ${authorizationToken}`
    }
    out[name] = Object.keys(mergedHeaders).length ? { ...rest, headers: mergedHeaders } : rest
  }
  return out
}

async function writeMcpConfigFile(servers: McpServers): Promise<string> {
  // Includes authorization tokens / headers — restrict to owner-only perms.
  const path = `/tmp/iaflow-mcp-${Date.now()}-${randomUUID().slice(0, 8)}.json`
  await Bun.write(path, JSON.stringify({ mcpServers: toCliMcpServers(servers) }, null, 2))
  await chmod(path, 0o600)
  return path
}

/**
 * Genera un settings.json temporal por run con un WorktreeCreate hook que
 * materializa `/tmp/ia-flow/<repo>/.worktrees/<taskId>` sobre la branch
 * canónica de la task. Devuelve el path del archivo para pasarlo a
 * `claude --settings`.
 *
 * Ventajas vs `git worktree add` inline:
 *   • Aprovecha la infra nativa de Claude Code: `resume`, `EnterWorktree`,
 *     `ExitWorktree`, cleanup periódico, watchdog de sesión.
 *   • El "worktree name" que Claude pinta en su UI queda alineado con el
 *     taskId y el branch git es exactamente `input.branch` (la linked
 *     branch de GitHub).
 *   • El hook es data-driven (paths y branch bakeados en el JSON) — no
 *     requiere script deployado en cada repo.
 *
 * Fallback chain del hook (mismo orden que WorkspaceManager):
 *   1) reusar branch remota (linked por createLinkedBranch)
 *   2) reusar branch local (algún run previo la creó)
 *   3) crear nueva desde origin/<baseBranch>
 *   4) si el worktree ya está en disco, `git worktree add` falla y solo
 *      hacemos `echo` del path (idempotencia).
 */
interface WorktreeHookOpts {
  taskId: string
  cwd: string
  branch: string
  baseBranch: string
  worktreePath: string
}

function buildWorktreeHook(opts: WorktreeHookOpts) {
  const { taskId, cwd, branch, baseBranch, worktreePath } = opts
  // El comando shell debe:
  //   • Ser idempotente ante reruns (los `|| true` cubren "ya existe").
  //   • Terminar con `echo "$path"` a stdout — Claude Code lee el path desde ahí.
  //   • No emitir nada más a stdout (stderr sí está permitido).
  // Identidad = taskId, NO path literal: en macOS `/tmp` es symlink a
  // `/private/tmp`, así que `git worktree list --porcelain` reporta la ruta
  // real y un grep contra `worktreePath` (que empieza con `/tmp/…`) nunca
  // matchea. Matcheamos por sufijo `.worktrees/<taskId>` — único por diseño.
  const createCmd = [
    `git -C "${cwd}" fetch origin >/dev/null 2>&1 || true`,
    `if ! git -C "${cwd}" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2}' | grep -qE "/\\.worktrees/${taskId}\$"; then`,
    `  git -C "${cwd}" worktree add "${worktreePath}" "${branch}" >/dev/null 2>&1 || \\`,
    `  git -C "${cwd}" worktree add -b "${branch}" "${worktreePath}" "origin/${branch}" >/dev/null 2>&1 || \\`,
    `  git -C "${cwd}" worktree add -b "${branch}" "${worktreePath}" "origin/${baseBranch}" >/dev/null 2>&1 || \\`,
    `  { echo "worktree add failed for task ${taskId}" >&2; exit 1; }`,
    `fi`,
    `echo "${worktreePath}"`,
  ].join('\n')

  // WorktreeRemove hook: Claude Code calls this after it removes a worktree.
  // Se dispara tanto por el worktree de la task principal como por worktrees
  // de subagentes con isolation=worktree. Debemos actuar SOLO cuando el path
  // removido corresponde al worktree de ESTA task — si no filtramos por path,
  // el hook borraría el branch de la task padre cada vez que un subagente
  // limpia su propio worktree. Identidad = sufijo `.worktrees/<taskId>`,
  // único por diseño (mismo criterio que WorktreeCreate).
  // The hook MUST NOT exit non-zero (Claude Code ignores the return value for
  // WorktreeRemove but a crash would be noise en el terminal).
  const removeCmd = [
    `payload=$(cat)`,
    `if echo "$payload" | grep -q "/\\.worktrees/${taskId}"; then`,
    // Best-effort branch delete — ignore failures (remote branch may not exist
    // locally, or was already deleted by the orchestrator auto-cleanup).
    `  git -C "${cwd}" branch -D "${branch}" >/dev/null 2>&1 || true`,
    `  echo "WorktreeRemove: cleaned branch ${branch} for task ${taskId}" >&2`,
    `fi`,
  ].join('\n')

  return {
    WorktreeCreate: [
      {
        hooks: [
          {
            type: 'command',
            command: `bash -c '${createCmd.replace(/'/g, "'\\''")}'`,
          },
        ],
      },
    ],
    WorktreeRemove: [
      {
        hooks: [
          {
            type: 'command',
            command: `bash -c '${removeCmd.replace(/'/g, "'\\''")}'`,
          },
        ],
      },
    ],
  }
}

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
  worktreeHook?: WorktreeHookOpts
  hookToolUse?: boolean
}): Promise<string | undefined> {
  const settings: Record<string, unknown> = {}
  if (opts.env && Object.keys(opts.env).length > 0) settings.env = opts.env
  const hooks: Record<string, unknown> = {}
  if (opts.worktreeHook) Object.assign(hooks, buildWorktreeHook(opts.worktreeHook))
  if (opts.hookToolUse) Object.assign(hooks, buildForwardedHooks())
  if (Object.keys(hooks).length > 0) settings.hooks = hooks
  if (Object.keys(settings).length === 0) return undefined

  const path = `/tmp/iaflow-settings-${Date.now()}-${randomUUID().slice(0, 8)}.json`
  await Bun.write(path, JSON.stringify(settings, null, 2))
  // Puede contener secretos (OAuth token, API keys de env). Owner-only.
  await chmod(path, 0o600)
  return path
}

export interface TerminalBaseDeps {
  toolExecution: Pick<ToolExecutionPort, 'buildToolInstructions'>
  loadProviderConfig: LoadProviderConfig
  worktree: WorktreePathResolver
}

/** Factory: builds the `buildClaudeCommand` closure with its three injected
 *  dependencies bound, so tmux/iterm providers don't each need to thread
 *  them through by hand. */
export function createTerminalBase(deps: TerminalBaseDeps) {
  const { toolExecution, loadProviderConfig, worktree } = deps

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
    /** File con el bloque "tools appendix" que se pasa via
     *  `--append-system-prompt-file`. Ausente cuando el agente no tiene tools. */
    syspromptFile?: string
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

    let mcpConfigFile: string | undefined
    if (resolvedMcpServers && Object.keys(resolvedMcpServers).length > 0) {
      mcpConfigFile = await writeMcpConfigFile(resolvedMcpServers)
      claudeFlags += ` --mcp-config "${mcpConfigFile}"`
    }

    // Instrucciones de tools (nombres + curl blocks) — antes se prependían al
    // user prompt (contaminando el agent.prompt y creando drift entre el
    // implementer terminal y el api). Ahora las escribimos a un file separado
    // y las pasamos via `--append-system-prompt-file`. Beneficios:
    //   • agent.prompt (DB) queda idéntico entre providers — el diseño del
    //     prompt no depende de si el provider consume tools nativas o via curl.
    //   • El bloque queda en el system prompt (cacheable con prompt caching).
    //   • Cero contaminación de la conversación / turnos.
    const daemonUrl = `http://localhost:${Bun.env.PORT ?? '3001'}`
    const toolsAppendix = toolExecution.buildToolInstructions(
      input.tools,
      { id: providerId, kind: 'async' },
      daemonUrl,
      input.taskId,
    )
    let syspromptFile: string | undefined
    if (toolsAppendix?.length) {
      syspromptFile = `/tmp/iaflow-sysprompt-${Date.now()}-${randomUUID().slice(0, 8)}.md`
      await Bun.write(syspromptFile, toolsAppendix)
      await chmod(syspromptFile, 0o600)
      claudeFlags += ` --append-system-prompt-file "${syspromptFile}"`
    }

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
    // workflow=worktree: registramos un WorktreeCreate hook que Claude Code
    // invoca en lugar de su lógica default de git. El hook materializa
    // `/tmp/ia-flow/<repo>/.worktrees/<taskId>` sobre la branch canónica
    // (`input.branch`) y emite ese path por stdout — Claude lo usa como cwd de
    // la sesión. Así ambos providers (anthropic-api via WorkspaceManager,
    // terminal via este hook) convergen en el mismo path y branch git.
    //
    // Docs: https://code.claude.com/docs/en/hooks#worktreecreate
    let worktreeHookOpts: WorktreeHookOpts | undefined
    let inlineBranchWrapper = ''
    let worktreeFlags = ''
    let cwdPrefix = ''
    if (input.step === 'implement' && input.cwd) {
      const workflow = input.workflow ?? 'branch'
      if (workflow === 'worktree') {
        const baseBranch = await resolveBaseBranch(input.cwd)
        if (baseBranch) {
          // Precheck: si ya existe un worktree para esta task con OTRA branch
          // (típicamente naming legacy previo a un rename), falla acá con un
          // mensaje claro en vez de dejar que el hook shell explote adentro del
          // terminal y quede fuera de la UI. El error se propaga por
          // provider.run → AgentOrchestrator → executionLog.errorMsg → banner.
          await assertWorktreeBranchMatches(input.cwd, input.taskId, branchName)
          worktreeHookOpts = {
            taskId: input.taskId,
            cwd: input.cwd,
            branch: branchName,
            baseBranch,
            worktreePath: worktree.worktreePathFor(input.cwd, input.taskId),
          }
          // `--worktree <taskId>` dispara WorktreeCreate; el nombre no se usa
          // como branch (el hook decide), solo como session/directory hint.
          cwdPrefix = `cd "${input.cwd}" && `
          worktreeFlags = ` --worktree "${input.taskId}"`
        }
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
      worktreeHook: worktreeHookOpts,
      hookToolUse: Boolean(input.runId),
    })
    if (settingsFile) claudeFlags = ` --settings "${settingsFile}"${claudeFlags}`

    // El user prompt es exclusivamente input.prompt (agent.prompt de la DB,
    // resuelto por el orquestador + gitContext prepended). El toolsAppendix
    // ya vive en el system prompt via --append-system-prompt-file.
    await Bun.write(promptFile, input.prompt)

    // Login shells (tmux `$SHELL -lc`, new iTerm tabs) re-source ~/.zshrc /
    // ~/.zprofile, which typically re-exports ANTHROPIC_API_KEY. Unset it
    // right before `claude` runs so el OAuth token (inyectado via settings.env)
    // gane sin conflicto.
    const cmd = `unset ANTHROPIC_API_KEY; ${cwdPrefix}${inlineBranchWrapper}claude${worktreeFlags}${claudeFlags} < "${promptFile}"`

    return { cmd, promptFile, mcpConfigFile, settingsFile, syspromptFile }
  }

  return { buildClaudeCommand }
}
