// Shared logic for terminal-based Claude providers (iTerm2 and tmux)
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { type McpServers, McpServersSchema, type TerminalProviderSettings } from '@ia-flow/shared'
import { z } from 'zod'
import { writeMcpConfigFile } from '../claude-cli/mcp-config.js'
import {
  type LocalToolsMcp,
  resolveDaemonToken,
  resolveDaemonUrl,
  resolveMcpServers,
} from '../claude-cli/tools-mcp.js'
import type { LoadProviderConfig, ProviderInput } from '../contract.js'

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

const execFileAsync = promisify(execFile)

/**
 * `execFile` bajo Bun tira **sincrónicamente** cuando ni siquiera puede lanzar
 * el proceso (binario fuera del `PATH`, límite de procesos del host): su
 * `promisify.custom` llama al original FUERA del executor de una promesa, así
 * que la excepción escapa antes de que exista la promesa a la que engancharle
 * un `.catch()`. Node siempre emite `'error'` y rechaza; Bun no.
 *
 * Eso se lleva puesto al daemon entero: adentro de una `async function` el
 * throw se vuelve un rechazo de ESA función —no del `pexec`—, así que el
 * `await pexec(...).catch(() => {})` de los call sites "que nunca fallan" no
 * lo cubre, nadie lo espera arriba, y Bun mata el proceso por unhandled
 * rejection. Normalizarlo a rechazo hace que el `catch` que cada call site ya
 * tiene alcance para los dos modos de fallo.
 */
export const pexec: typeof execFileAsync = ((...args: Parameters<typeof execFileAsync>) => {
  try {
    return execFileAsync(...args)
  } catch (err) {
    return Promise.reject(err)
  }
}) as typeof execFileAsync

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

// ─── Etiquetas de las superficies del SO ──────────────────────────────────
//
// El nombre de la sesión de tmux y el título de la tab de iTerm son lo ÚNICO
// que un humano ve de un run desde afuera (`tmux ls`, la barra de tabs). Antes
// llevaban sólo el título de la task, así que dos agentes distintos sobre el
// mismo issue producían sesiones indistinguibles —`iaflow-scoped-config-list`
// y `iaflow-scoped-config-list-2`— y no había forma de saber cuál era el
// builder y cuál el reviewer sin entrar.

/** Lo que las etiquetas necesitan de un run — subconjunto de `ProviderInput`. */
export interface RunLabelSource {
  agentId?: string
  taskId: string
  taskTitle: string
  issueNumber?: number
}

/**
 * Identificador legible de la task: `task-<issue>`, la MISMA forma con la que
 * `@ia-flow/workspace` nombra su worktree — el que mira la sesión ve el mismo
 * nombre en la etiqueta y en el `pwd`.
 *
 * El `taskId` crudo queda afuera a propósito: en GitHub Projects es un node id
 * opaco (`PVTI_lAHOAIgSic4Bf4pzzg3fXxk`) que no dice nada en un `tmux ls`. Sólo
 * se usa su sufijo cuando el source no numera issues.
 */
export function taskLabel(input: RunLabelSource): string {
  if (input.issueNumber != null) return `task-${input.issueNumber}`
  return `task-${slugify(input.taskId).slice(-6) || 'task'}`
}

/**
 * Cuerpo del nombre de la sesión de tmux: `<agente>-task-<issue>`, la misma
 * información que el título de la tab de iTerm. Sin el prefijo `iaflow-`, que
 * lo pone el provider.
 *
 * El separador es `-` y no `:` a propósito: `:` (y `.`) son separadores de
 * target de tmux —`sesión:ventana.panel`—, así que un `:` en el nombre lo
 * reescribe a `_` al crear la sesión y rompe todo `-t <nombre>` posterior.
 *
 * El título del issue quedó afuera: no cabe legible en un `tmux ls` y el par
 * agente+issue ya identifica el run. Las colisiones (mismo agente, mismo
 * issue) las desambigua `pickSessionName` con un sufijo numérico.
 */
export function tmuxSessionLabel(input: RunLabelSource): string {
  const agent = input.agentId?.trim() ? slugify(input.agentId).slice(0, 24) : ''
  return (
    [agent, taskLabel(input)].filter(Boolean).join('-').replace(/-+/g, '-').replace(/^-|-$/g, '') ||
    'task'
  )
}

/**
 * Título de la tab de iTerm: `<agente>: task-<issue>`.
 *
 * Sólo agente + issue: la tab es angosta y lo único que se necesita leer de
 * un vistazo es QUIÉN está corriendo y SOBRE QUÉ issue. El título del issue
 * empujaba esos dos datos fuera del ancho visible; se lee en ia-flow.
 */
export function itermTabTitle(input: RunLabelSource): string {
  const agent = input.agentId?.trim()
  return agent ? `${agent}: ${taskLabel(input)}` : taskLabel(input)
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
//
// `IA_FLOW_HOOK_SCRIPT_PATH` gana porque en un BUNDLE este archivo no está en
// disco: `import.meta.url` apunta al bundle, así que la ruta resuelve a un
// `hook-tool-use.ts` al lado de `server.js` que nunca se copió. Es el caso de
// las imágenes de cada app y del artefacto publicado, o sea el caso normal
// en producción — no un escenario exótico.
//
// Quien quiera providers de terminal desde un bundle tiene que apuntar esta
// variable a una copia del script. (Y seguir teniendo `bun` y `claude` en el
// PATH: el hook se ejecuta con `bun`.)
const HOOK_TOOL_USE_PATH =
  Bun.env.IA_FLOW_HOOK_SCRIPT_PATH ?? new URL('./hook-tool-use.ts', import.meta.url).pathname

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
  /**
   * Dónde alcanzar el MCP de tools de disco de ESTE proceso, si lo tiene.
   *
   * Sólo lo inyecta el agent-host (`/v1/mcp`), y es lo que parte la entrega
   * de tools en dos: las de disco se resuelven acá —donde está el workspace
   * que este proceso preparó— y el resto sigue yendo al daemon. Sin esto,
   * un `fs_write` de un agente de terminal remoto escribía en el disco del
   * daemon mientras el Read/Write nativo del CLI operaba en este.
   *
   * Ausente ⇒ un run local, donde el daemon YA es esta máquina y partirlo no
   * tendría sentido: un solo MCP, exactamente como antes.
   *
   * Función y no string porque el puerto y el token del agent-host se
   * resuelven después de que el provider se construye.
   *
   * `owns` lo trae el inyector y no lo deduce este módulo: quién sabe sobre
   * qué disco opera cada tool es el registry (`@ia-flow/tools`), y
   * `ai-providers` no puede importarlo — `tools` depende de `agent-engine`,
   * que depende de este paquete.
   */
  localTools?: () => LocalToolsMcp | undefined
}

// ─── Helpers de `buildClaudeCommand` ──────────────────────────────────────
//
// Cada uno cubre una responsabilidad bien delimitada de armar el comando
// final: resolver settings del provider, el flag string, el MCP sintético de
// tools, el sysprompt, las env vars y el wrapper de branch inline. Extraídos
// como funciones puras (module-level) para que `buildClaudeCommand` quede
// como la orquestación, no la lógica — el comando resultante es byte a byte
// el mismo que antes de la extracción.

type ResolvedTerminalSettings = {
  model?: string
  dangerouslySkipPermissions?: boolean
  mcpServers?: McpServers
}

/** Per-agent override (`providerConfig` del agente) sobre defaults del
 *  provider (`tmuxClaude`/`itermClaude` en la config global). El agente
 *  gana campo por campo, no todo-o-nada. */
function resolveTerminalSettings(
  pc: z.infer<typeof TerminalAgentConfigSchema> | undefined,
  termDefaults: TerminalProviderSettings,
): ResolvedTerminalSettings {
  return {
    model: pc?.model ?? termDefaults.model,
    dangerouslySkipPermissions:
      pc?.dangerouslySkipPermissions ?? termDefaults.dangerouslySkipPermissions,
    mcpServers: pc?.mcpServers ?? termDefaults.mcpServers,
  }
}

function buildModelAndPermissionFlags(model: string | undefined, dsp: boolean | undefined): string {
  let flags = ''
  if (model) flags += ` --model ${model}`
  if (dsp) flags += ' --dangerously-skip-permissions'
  return flags
}

/** Los `systemPromptBlocks` del agente + la nota de sesión desatendida
 *  (siempre última: es del engine y describe el modo de ejecución, así que
 *  gana sobre cualquier cosa que el prompt del agente diga al respecto). */
function buildSyspromptText(input: ProviderInput): string {
  const agentSystemText = (input.systemPromptBlocks ?? [])
    .map((b) => b.text)
    .filter((t) => t.trim())
    .join('\n\n')
  return agentSystemText
    ? `${agentSystemText}\n\n${UNATTENDED_SESSION_NOTE}`
    : UNATTENDED_SESSION_NOTE
}

/** Env vars del terminal (`settings.json` → `env:`), incluyendo el OAuth
 *  token de fallback y las vars que consume `terminal/hook-tool-use.ts`. */
function buildRunEnv(
  input: ProviderInput,
  termDefaults: TerminalProviderSettings,
  daemonUrl: string,
  daemonToken: string | undefined,
): Record<string, string> {
  const runEnv: Record<string, string> = { ...(termDefaults.env ?? {}) }
  if (Bun.env.CLAUDE_CODE_OAUTH_TOKEN && !runEnv.CLAUDE_CODE_OAUTH_TOKEN) {
    runEnv.CLAUDE_CODE_OAUTH_TOKEN = Bun.env.CLAUDE_CODE_OAUTH_TOKEN
  }
  if (input.runId) {
    runEnv.IA_FLOW_RUN_ID = input.runId
    runEnv.IA_FLOW_SERVER_URL = daemonUrl
    if (daemonToken) runEnv.IA_FLOW_API_TOKEN = daemonToken
  }
  return runEnv
}

/** Wrapper de shell que hace `git checkout` in-place cuando el workflow es
 *  `branch` (no `worktree`) y el repo tiene un base branch resoluble. Sólo
 *  aplica al step `implement`, que es el único que muta el working tree. */
async function resolveInlineBranchWrapper(
  input: ProviderInput,
  branchName: string,
): Promise<string> {
  if (input.step !== 'implement' || !input.cwd) return ''
  const workflow = input.workflow ?? 'branch'
  if (workflow !== 'branch') return ''
  const baseBranch = await resolveBaseBranch(input.cwd)
  if (!baseBranch) return ''
  return `git checkout -b ${branchName} 2>/dev/null || git checkout ${branchName} && `
}

/** Factory: builds the `buildClaudeCommand` closure with its two injected
 *  dependencies bound, so tmux/iterm providers don't each need to thread
 *  them through by hand. */
export function createTerminalBase(deps: TerminalBaseDeps) {
  const { loadProviderConfig } = deps

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
    const termDefaults: TerminalProviderSettings =
      providerId === 'iterm-claude' ? (config.itermClaude ?? {}) : (config.tmuxClaude ?? {})

    // Per-agent override — validated against this provider's private schema.
    const pc = parseTerminalAgentConfig(input.providerConfig)
    const {
      model,
      dangerouslySkipPermissions: dsp,
      mcpServers: resolvedMcpServers,
    } = resolveTerminalSettings(pc, termDefaults)

    let claudeFlags = buildModelAndPermissionFlags(model, dsp)

    // Notar que en un agent-host `PORT` es el suyo (3002), así que sin
    // `daemonUrl` apuntaríamos las tools del agente al propio agent-host, que
    // no tiene /api/mcp. Token del guard de la API del daemon
    // (`createApiAuthMiddleware`): sin él el MCP sintético y el hook de
    // tool_use contestan 401 apenas alguien configura `IA_FLOW_API_TOKEN`, y
    // el síntoma del lado del CLI es un "failed to connect" del server
    // `ia-flow-tools`: el run arranca sin NINGUNA tool del agente.
    const daemonUrl = resolveDaemonUrl(input)
    const daemonToken = resolveDaemonToken(input)

    // Agent-declared tools reach the CLI as one more MCP server pointing at
    // the daemon's own /api/mcp endpoint — same wire format as any catalog
    // entry (github-mcp, etc), instead of the old curl-recipe appendix.
    const mcpServers = resolveMcpServers({
      input,
      configured: resolvedMcpServers,
      daemonUrl,
      daemonToken,
      localTools: deps.localTools?.(),
      // Terminal cierra con `complete_task`: el proceso del CLI sobrevive a
      // la respuesta y el engine espera su callback.
      kind: 'async',
    })

    let mcpConfigFile: string | undefined
    if (Object.keys(mcpServers).length > 0) {
      mcpConfigFile = await writeMcpConfigFile(mcpServers)
      claudeFlags += ` --mcp-config "${mcpConfigFile}"`
    }

    // Los `systemPromptBlocks` del agente van acá, NO al prompt file.
    //
    // Antes se descartaban: el sysprompt file llevaba sólo la nota de sesión
    // desatendida, así que todo lo que un agente declarara en `systemPrompts`
    // (las reglas transversales del proyecto incluidas) desaparecía apenas el
    // run caía en un provider de terminal. Silencioso y difícil de ver, porque
    // el agente igual corre — con menos instrucciones de las que su definición
    // dice que tiene.
    const syspromptFile = `/tmp/iaflow-sysprompt-${Date.now()}-${randomUUID().slice(0, 8)}.md`
    await writeFile(syspromptFile, buildSyspromptText(input), { mode: 0o600 })
    claudeFlags += ` --append-system-prompt-file "${syspromptFile}"`

    // Env vars del terminal viven en settings.json (`env:`) — no se exportan en
    // el shell, evita filtrarlas al buffer visible y unifica la convención con
    // el hook WorktreeCreate (ambos comparten el mismo archivo `--settings`).
    const runEnv = buildRunEnv(input, termDefaults, daemonUrl, daemonToken)

    // El texto "git context" (branch, worktree, workflow) lo inyecta el
    // orquestador via `buildGitContext` para que ambos providers reciban el
    // mismo bloque. Acá solo elegimos el shell wrapper que aplica el workflow.
    //
    // El terreno ya está preparado antes de llegar acá: `prepareWorkspace`
    // (ver TerminalWorkspaceProvisioner en @ia-flow/workspace) materializó el
    // worktree cuando `workflow=worktree` y dejó `input.cwd` apuntando ahí,
    // que es con lo que el provider spawnea la sesión. Por eso este archivo
    // ya no crea worktrees ni necesita un `cd`: antes tenía su propia copia
    // de esa maquinaria (con su cadena de fallbacks de `git worktree add` y
    // su convención de nombres) que divergía de la del provider sync.
    //
    // Sigue valiendo la decisión de NO pasar `--worktree` a la CLI: ese flag
    // dispara el evento WorktreeCreate, cuyos hooks se mergean entre TODAS
    // las fuentes de settings (user, project y el `--settings` per-run). Un
    // WorktreeCreate global en la máquina del usuario correría junto al
    // nuestro y su stdout puede ganar como cwd de la sesión: quedarían DOS
    // worktrees para la misma task. Sin el flag no hay evento, no hay merge
    // de hooks y el path lo decide ia-flow, igual en cualquier máquina.
    const inlineBranchWrapper = await resolveInlineBranchWrapper(input, branchName)

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
    const cmd = `unset ANTHROPIC_API_KEY; ${inlineBranchWrapper}claude${claudeFlags} < "${promptFile}"`

    return { cmd, promptFile, mcpConfigFile, settingsFile, syspromptFile }
  }

  return { buildClaudeCommand }
}
