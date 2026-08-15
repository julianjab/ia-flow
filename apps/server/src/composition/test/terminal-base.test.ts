import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type ProviderInput,
  assertWorktreeBranchMatches,
  createTerminalBase,
  pexec,
} from '@ia-flow/ai-providers'
// Registers the built-in async-visible tools so `buildToolInstructions`'s
// curl appendix is non-empty when this file runs in isolation — same
// convention as `@ia-flow/tools`' own policy.test.ts. In the running app
// these are registered by `routes/tools.ts` at boot.
import '@ia-flow/tools'
import {
  DEFAULT_TERMINAL_SETTINGS,
  loadProviderConfig,
  saveProviderConfig,
} from '../../application/provider-config.js'
import { promptRepo, terminalBaseDeps } from '../container.js'

const { buildClaudeCommand } = createTerminalBase(terminalBaseDeps)

let originalDbConfig: Record<string, unknown> | null = null

// Repo git local con branch, usado como `cwd` en los tests de workflow para no
// depender del estado git del cwd real (en CI, actions/checkout deja HEAD
// detached — `resolveBaseBranch` retorna null y los tests pierden el shell
// wrapper de branch/worktree).
let sharedRepoDir = ''
let sharedRepo = ''

beforeAll(async () => {
  originalDbConfig = promptRepo.getProviderConfigBlob()
  const cfg = await loadProviderConfig()
  await saveProviderConfig({
    ...cfg,
    tmuxClaude: { ...DEFAULT_TERMINAL_SETTINGS },
    itermClaude: { ...DEFAULT_TERMINAL_SETTINGS },
  })

  sharedRepoDir = await mkdtemp(join(tmpdir(), 'iaflow-workflow-repo-'))
  sharedRepo = join(sharedRepoDir, 'repo')
  await pexec('git', ['init', '-q', '-b', 'main', sharedRepo])
  await pexec('git', [
    '-C',
    sharedRepo,
    '-c',
    'user.email=ci@ia-flow.test',
    '-c',
    'user.name=ia-flow ci',
    'commit',
    '--allow-empty',
    '-m',
    'init',
    '-q',
  ])
})

afterAll(async () => {
  if (originalDbConfig !== null) promptRepo.setProviderConfigBlob(originalDbConfig)
  else promptRepo.deleteProviderConfigBlob()
  if (sharedRepoDir) await rm(sharedRepoDir, { recursive: true, force: true })
})

function baseInput(overrides: Partial<ProviderInput> = {}): ProviderInput {
  return {
    step: 'refine-functional',
    taskTitle: 'flag-test',
    taskDescription: 'd',
    taskType: 'feat',
    repos: [],
    repoPaths: {},
    prompt: 'hi',
    ...overrides,
  }
}

// El OAuth token del user machine podría inyectarse en runEnv y generar un
// --settings implícito, contaminando los cmd exactos. Lo neutralizamos.
const savedOauthToken = Bun.env.CLAUDE_CODE_OAUTH_TOKEN
beforeAll(() => {
  Bun.env.CLAUDE_CODE_OAUTH_TOKEN = ''
})
afterAll(() => {
  if (savedOauthToken !== undefined) Bun.env.CLAUDE_CODE_OAUTH_TOKEN = savedOauthToken
  else delete Bun.env.CLAUDE_CODE_OAUTH_TOKEN
})

describe('buildClaudeCommand — terminal per-agent providerConfig', () => {
  it('emits all flags when providerConfig sets model and dangerouslySkipPermissions', async () => {
    const { cmd, promptFile, syspromptFile } = await buildClaudeCommand(
      baseInput({
        providerConfig: {
          model: 'claude-opus-4-7',
          dangerouslySkipPermissions: true,
        },
      }),
      'tmux-claude',
    )
    // syspromptFile viene por el toolsAppendix con las built-in tools (async).
    expect(syspromptFile).toBeDefined()
    expect(cmd).toBe(
      `unset ANTHROPIC_API_KEY; claude --model claude-opus-4-7 --dangerously-skip-permissions --append-system-prompt-file "${syspromptFile}" < "${promptFile}"`,
    )
  })

  it('emits no flags when providerConfig is absent and no terminal defaults set', async () => {
    const { cmd, promptFile, syspromptFile } = await buildClaudeCommand(baseInput(), 'iterm-claude')
    // sysprompt siempre viene mientras haya tools built-in async (complete_task, etc).
    expect(cmd).toBe(
      `unset ANTHROPIC_API_KEY; claude --append-system-prompt-file "${syspromptFile}" < "${promptFile}"`,
    )
  })

  it('emits only --dangerously-skip-permissions when only that flag is set', async () => {
    const { cmd, promptFile, syspromptFile } = await buildClaudeCommand(
      baseInput({
        providerConfig: { dangerouslySkipPermissions: true },
      }),
      'tmux-claude',
    )
    expect(cmd).toBe(
      `unset ANTHROPIC_API_KEY; claude --dangerously-skip-permissions --append-system-prompt-file "${syspromptFile}" < "${promptFile}"`,
    )
  })

  it('escribe env de terminal defaults en settings.json y pasa --settings (no export en el shell)', async () => {
    const cfg = await loadProviderConfig()
    await saveProviderConfig({
      ...cfg,
      tmuxClaude: { ...DEFAULT_TERMINAL_SETTINGS, env: { FOO: 'bar', BAZ: 'qux' } },
    })
    try {
      const { cmd, settingsFile } = await buildClaudeCommand(baseInput(), 'tmux-claude')
      expect(settingsFile).toBeDefined()
      expect(cmd).toContain(`--settings "${settingsFile}"`)
      // No `export FOO=` en el cmd — env vive únicamente en settings.json.
      expect(cmd).not.toContain('export FOO')
      const written = JSON.parse(await Bun.file(settingsFile!).text())
      expect(written.env).toEqual({ FOO: 'bar', BAZ: 'qux' })
    } finally {
      await saveProviderConfig({ ...cfg, tmuxClaude: { ...DEFAULT_TERMINAL_SETTINGS } })
    }
  })

  it('no emite --settings cuando no hay env ni hook (evita archivo vacío)', async () => {
    const { cmd, settingsFile } = await buildClaudeCommand(baseInput(), 'tmux-claude')
    expect(settingsFile).toBeUndefined()
    expect(cmd).not.toContain('--settings')
  })

  it('registra los 6 hooks forwarder en settings.json cuando input.runId está presente', async () => {
    const { settingsFile } = await buildClaudeCommand(
      baseInput({ runId: 'run-abc' }),
      'tmux-claude',
    )
    expect(settingsFile).toBeDefined()
    const written = JSON.parse(await Bun.file(settingsFile!).text()) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>
    }
    const hookNames = [
      'PreToolUse',
      'PostToolUse',
      'UserPromptSubmit',
      'Stop',
      'SubagentStop',
      'SessionStart',
    ]
    for (const name of hookNames) {
      const entry = written.hooks[name]
      expect(entry, `${name} debe estar registrado`).toBeDefined()
      expect(entry[0].hooks[0].command).toContain('hook-tool-use.ts')
      // Cada hook pasa su nombre como argv[2] al forwarder — así el script
      // arma el body /api/hook-events correcto por evento.
      expect(entry[0].hooks[0].command).toContain(` ${name}`)
    }
  })

  it('adds --mcp-config flag and writes JSON when providerConfig sets mcpServers', async () => {
    const { cmd, mcpConfigFile } = await buildClaudeCommand(
      baseInput({
        providerConfig: {
          mcpServers: {
            docs: { type: 'http', url: 'https://mcp.example/docs' },
          },
        },
      }),
      'tmux-claude',
    )
    expect(mcpConfigFile).toBeDefined()
    expect(cmd).toContain(`--mcp-config "${mcpConfigFile}"`)
    const written = JSON.parse(await Bun.file(mcpConfigFile!).text())
    expect(written).toEqual({
      mcpServers: { docs: { type: 'http', url: 'https://mcp.example/docs' } },
    })
  })

  it('adds --mcp-config for iterm-claude when mcpServers configured', async () => {
    const { cmd, mcpConfigFile } = await buildClaudeCommand(
      baseInput({
        providerConfig: {
          mcpServers: {
            local: { type: 'stdio', command: 'node', args: ['s.js'] },
          },
        },
      }),
      'iterm-claude',
    )
    expect(mcpConfigFile).toBeDefined()
    expect(cmd).toContain(`--mcp-config "${mcpConfigFile}"`)
  })

  it('does not add --mcp-config when mcpServers is empty or absent', async () => {
    const { cmd, mcpConfigFile } = await buildClaudeCommand(
      baseInput({ providerConfig: { mcpServers: {} } }),
      'tmux-claude',
    )
    expect(mcpConfigFile).toBeUndefined()
    expect(cmd).not.toContain('--mcp-config')

    const bare = await buildClaudeCommand(baseInput(), 'tmux-claude')
    expect(bare.mcpConfigFile).toBeUndefined()
    expect(bare.cmd).not.toContain('--mcp-config')
  })

  it('implement + workflow=branch → checks out task/<taskId>', async () => {
    // El texto de "git context" ya no lo arma terminal-base (lo inyecta el
    // orquestador via buildGitContext), pero el wrapper de shell sí — usa
    // task/<taskId> derivado de input.taskId, no del slug del título.
    const { cmd } = await buildClaudeCommand(
      baseInput({
        step: 'implement',
        taskId: 'ABC123',
        taskTitle: 'título con espacios y ácentos',
        cwd: sharedRepo,
        workflow: 'branch',
      }),
      'tmux-claude',
    )
    expect(cmd).toContain('git checkout -b task/ABC123')
    expect(cmd).toContain('git checkout task/ABC123')
    expect(cmd).not.toContain('feat/')
  })

  it('implement + workflow=worktree → genera settings.json con hook WorktreeCreate y pasa --settings + --worktree <taskId>', async () => {
    // El terminal delega la creación del worktree al hook nativo de
    // Claude Code (WorktreeCreate). Genera un settings.json temporal con el
    // hook bakeado y lo pasa via `--settings`. El nombre de `--worktree`
    // es el taskId (session/dir hint); el hook decide branch y path reales.
    const { cmd, settingsFile } = await buildClaudeCommand(
      baseInput({
        step: 'implement',
        taskId: 'XYZ789',
        cwd: sharedRepo,
        workflow: 'worktree',
        branch: 'feat/add-invites-XYZ789',
      }),
      'tmux-claude',
    )
    expect(settingsFile).toBeDefined()
    expect(cmd).toContain(`--settings "${settingsFile}"`)
    expect(cmd).toContain('--worktree "XYZ789"')

    // El settings.json debe contener el hook WorktreeCreate con el path y
    // branch bakeados; el hook shell emite el worktree path por stdout.
    const settings = JSON.parse(await Bun.file(settingsFile!).text()) as {
      hooks: { WorktreeCreate: Array<{ hooks: Array<{ command: string }> }> }
    }
    const hookCmd = settings.hooks.WorktreeCreate[0].hooks[0].command
    expect(hookCmd).toContain('feat/add-invites-XYZ789')
    expect(hookCmd).toContain('/tmp/ia-flow/')
    expect(hookCmd).toContain('.worktrees/XYZ789')
    expect(hookCmd).toContain('worktree add')
    // Regresión: el check de "worktree ya existe" matchea por taskId
    // (`.worktrees/<taskId>$`), NO por el path literal — evita el bug de
    // macOS donde `git worktree list` reporta `/private/tmp/...` y un grep
    // contra `/tmp/...` nunca matcheaba.
    expect(hookCmd).toContain('/\\.worktrees/XYZ789$')
    expect(hookCmd).not.toMatch(/grep -q "worktree \/tmp/)
  })

  it('implement + workflow=worktree sin input.branch → hook usa fallback task/<taskId>', async () => {
    const { settingsFile } = await buildClaudeCommand(
      baseInput({
        step: 'implement',
        taskId: 'WT1',
        cwd: sharedRepo,
        workflow: 'worktree',
      }),
      'tmux-claude',
    )
    const settings = JSON.parse(await Bun.file(settingsFile!).text()) as {
      hooks: { WorktreeCreate: Array<{ hooks: Array<{ command: string }> }> }
    }
    const hookCmd = settings.hooks.WorktreeCreate[0].hooks[0].command
    expect(hookCmd).toContain('task/WT1')
  })

  it('implement + workflow=main → no branch checkout, no --worktree', async () => {
    const { cmd } = await buildClaudeCommand(
      baseInput({
        step: 'implement',
        taskId: 'MAIN1',
        cwd: process.cwd(),
        workflow: 'main',
      }),
      'tmux-claude',
    )
    expect(cmd).not.toContain('git checkout -b')
    expect(cmd).not.toContain('--worktree')
  })

  it('ignores providerConfig with fields foreign to the terminal provider schema', async () => {
    // Under the open providerConfig shape, per-provider strictness lives in
    // each provider file. The terminal schema is strict and knows only
    // `model` and `dangerouslySkipPermissions` — extra keys make parsing
    // fail and the override is dropped (safe default).
    const { cmd, promptFile, syspromptFile } = await buildClaudeCommand(
      baseInput({
        providerConfig: { effort: 'high', taskBudgetTokens: 30000 },
      }),
      'tmux-claude',
    )
    expect(cmd).toBe(
      `unset ANTHROPIC_API_KEY; claude --append-system-prompt-file "${syspromptFile}" < "${promptFile}"`,
    )
  })

  it('implement + workflow=worktree → settings.json incluye WorktreeRemove hook con git branch -D', async () => {
    // WorktreeRemove hook debe estar presente junto a WorktreeCreate cuando el
    // workflow es worktree. Permite que Claude Code llame al hook al terminar
    // de remover el worktree de un subagente (isolation=worktree), eliminando
    // la branch local automáticamente.
    const { settingsFile } = await buildClaudeCommand(
      baseInput({
        step: 'implement',
        taskId: 'RMV1',
        cwd: sharedRepo,
        workflow: 'worktree',
        branch: 'feat/remove-test-RMV1',
      }),
      'tmux-claude',
    )
    expect(settingsFile).toBeDefined()
    const settings = JSON.parse(await Bun.file(settingsFile!).text()) as {
      hooks: {
        WorktreeCreate: Array<{ hooks: Array<{ command: string }> }>
        WorktreeRemove: Array<{ hooks: Array<{ command: string }> }>
      }
    }
    // WorktreeCreate must still be present (shape unchanged).
    expect(settings.hooks.WorktreeCreate).toBeDefined()

    // WorktreeRemove must be present with the branch -D command.
    expect(settings.hooks.WorktreeRemove).toBeDefined()
    const removeHookCmd = settings.hooks.WorktreeRemove[0].hooks[0].command
    expect(removeHookCmd).toContain('branch -D')
    expect(removeHookCmd).toContain('feat/remove-test-RMV1')
    // Should be best-effort (not exit 1 on failure)
    expect(removeHookCmd).toContain('|| true')
    // Debe filtrar por path del worktree de esta task (`.worktrees/<taskId>`)
    // para no borrar el branch de la task padre cuando un subagente con
    // isolation=worktree dispara su propio WorktreeRemove.
    expect(removeHookCmd).toContain('.worktrees/RMV1')
    expect(removeHookCmd).toContain('payload=$(cat)')
  })

  it('WorktreeRemove hook shape is consistent with WorktreeCreate (type: command)', async () => {
    const { settingsFile } = await buildClaudeCommand(
      baseInput({
        step: 'implement',
        taskId: 'RMV2',
        cwd: sharedRepo,
        workflow: 'worktree',
      }),
      'iterm-claude',
    )
    expect(settingsFile).toBeDefined()
    const settings = JSON.parse(await Bun.file(settingsFile!).text()) as {
      hooks: {
        WorktreeCreate: Array<{ hooks: Array<{ type: string; command: string }> }>
        WorktreeRemove: Array<{ hooks: Array<{ type: string; command: string }> }>
      }
    }
    // Both hooks follow the same shape: array of { hooks: [{ type, command }] }
    const createEntry = settings.hooks.WorktreeCreate[0]
    const removeEntry = settings.hooks.WorktreeRemove[0]
    expect(createEntry.hooks[0].type).toBe('command')
    expect(removeEntry.hooks[0].type).toBe('command')
    expect(typeof removeEntry.hooks[0].command).toBe('string')
  })

  it('workflow != worktree → no WorktreeRemove hook in settings.json', async () => {
    const { settingsFile } = await buildClaudeCommand(
      baseInput({
        step: 'implement',
        taskId: 'NO_RMV',
        cwd: sharedRepo,
        workflow: 'branch',
      }),
      'tmux-claude',
    )
    // workflow=branch generates no settings file (no hook, no env).
    // If it does generate one, WorktreeRemove must be absent.
    if (settingsFile) {
      const settings = JSON.parse(await Bun.file(settingsFile).text()) as {
        hooks?: { WorktreeRemove?: unknown }
      }
      expect(settings.hooks?.WorktreeRemove).toBeUndefined()
    }
  })

  it('assertWorktreeBranchMatches → lanza si el worktree existente tiene otra branch', async () => {
    // Setup: repo desnudo con un worktree preexistente que apunta a una branch
    // "legacy" — el escenario real que motivó el precheck (renombramos las
    // branches nuevas y quedaron worktrees stale con el naming viejo).
    const dir = await mkdtemp(join(tmpdir(), 'iaflow-wt-precheck-'))
    const repo = join(dir, 'repo')
    const worktreeParent = join(dir, 'wt', '.worktrees')
    const worktreePath = join(worktreeParent, 'TASK1')
    try {
      await pexec('git', ['init', '-q', '-b', 'main', repo])
      await pexec('git', [
        '-C',
        repo,
        '-c',
        'user.email=ci@ia-flow.test',
        '-c',
        'user.name=ia-flow ci',
        'commit',
        '--allow-empty',
        '-m',
        'init',
        '-q',
      ])
      await pexec('git', ['-C', repo, 'worktree', 'add', '-b', 'feat/legacy-name', worktreePath])

      // (1) Branch esperada distinta → falla con mensaje procesable.
      await expect(assertWorktreeBranchMatches(repo, 'TASK1', 'feat/new-name')).rejects.toThrow(
        /ya existe.*feat\/legacy-name.*se esperaba "feat\/new-name"/,
      )

      // (2) Branch esperada coincide → no-op.
      await expect(
        assertWorktreeBranchMatches(repo, 'TASK1', 'feat/legacy-name'),
      ).resolves.toBeUndefined()

      // (3) TaskId sin worktree registrado → no-op.
      await expect(
        assertWorktreeBranchMatches(repo, 'TASK_UNKNOWN', 'anything'),
      ).resolves.toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('escribe el toolsAppendix en syspromptFile (no en promptFile) y el user prompt queda limpio', async () => {
    const { promptFile, syspromptFile } = await buildClaudeCommand(
      baseInput({ prompt: 'contenido crudo del agente' }),
      'tmux-claude',
    )
    // User prompt file = SOLO input.prompt (sin toolsAppendix).
    const userPrompt = await Bun.file(promptFile).text()
    expect(userPrompt).toBe('contenido crudo del agente')
    // Sysprompt file = el bloque "Herramientas disponibles" con curl blocks.
    expect(syspromptFile).toBeDefined()
    const sys = await Bun.file(syspromptFile!).text()
    expect(sys).toContain('## Herramientas disponibles')
    expect(sys).toContain('curl')
  })
})
