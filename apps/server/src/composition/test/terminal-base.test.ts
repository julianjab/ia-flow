import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { type ProviderInput, createTerminalBase, pexec } from '@ia-flow/ai-providers'
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
  // Defensivo: este archivo ya no materializa worktrees (eso vive en
  // @ia-flow/workspace), pero el basename del repo temporal es fijo ('repo'),
  // así que se limpia igual por si una corrida vieja dejó algo.
  await rm(join('/tmp/ia-flow', basename(sharedRepo)), { recursive: true, force: true })
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
    expect(cmd).toBe(
      `unset ANTHROPIC_API_KEY; claude --model claude-opus-4-7 --dangerously-skip-permissions --append-system-prompt-file "${syspromptFile}" < "${promptFile}"`,
    )
  })

  it('emits no flags when providerConfig is absent and no terminal defaults set', async () => {
    const { cmd, promptFile, syspromptFile } = await buildClaudeCommand(baseInput(), 'iterm-claude')
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

  it('always appends the unattended-session note, independent of tools/mcpServers', async () => {
    const { syspromptFile } = await buildClaudeCommand(baseInput(), 'tmux-claude')
    const sys = await Bun.file(syspromptFile).text()
    expect(sys).toContain('Sesión desatendida')
    expect(sys).toContain('No preguntes')
    expect(sys).toContain('complete_task')
    expect(sys).toContain('fail_task')
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

  // El worktree en sí lo materializa `prepareWorkspace` (ver
  // TerminalWorkspaceProvisioner y los tests de @ia-flow/workspace); acá sólo
  // queda lo que este archivo sigue decidiendo: los flags y el shell wrapper.
  it('workflow=worktree ya no registra hooks WorktreeCreate/WorktreeRemove', async () => {
    const { settingsFile } = await buildClaudeCommand(
      baseInput({
        step: 'implement',
        taskId: 'NOHOOK1',
        issueNumber: 901,
        cwd: sharedRepo,
        workflow: 'worktree',
        branch: 'feat/no-hook',
      }),
      'tmux-claude',
    )
    if (settingsFile) {
      const settings = JSON.parse(await Bun.file(settingsFile).text()) as {
        hooks?: Record<string, unknown>
      }
      expect(settings.hooks?.WorktreeCreate).toBeUndefined()
      expect(settings.hooks?.WorktreeRemove).toBeUndefined()
    }
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
    // `model` and `dangerouslySkipPermissions`. Extra keys make parsing
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

  it('el user prompt es exclusivamente input.prompt, sin contaminación de tools', async () => {
    const { promptFile } = await buildClaudeCommand(
      baseInput({ prompt: 'contenido crudo del agente' }),
      'tmux-claude',
    )
    const userPrompt = await Bun.file(promptFile).text()
    expect(userPrompt).toBe('contenido crudo del agente')
  })

  it('adds a synthetic ia-flow-tools MCP entry pointing at /api/mcp when the agent declares tools', async () => {
    const { mcpConfigFile } = await buildClaudeCommand(
      baseInput({ tools: ['update_issue_body', 'complete_task'] }),
      'tmux-claude',
    )
    expect(mcpConfigFile).toBeDefined()
    const written = JSON.parse(await Bun.file(mcpConfigFile!).text())
    const entry = written.mcpServers['ia-flow-tools']
    expect(entry.type).toBe('http')
    expect(entry.url).toContain('/api/mcp?tools=')
    expect(entry.url).toContain('update_issue_body')
    expect(entry.url).toContain('complete_task')
  })

  it('merges the synthetic ia-flow-tools entry alongside catalog mcpServers', async () => {
    const { mcpConfigFile } = await buildClaudeCommand(
      baseInput({
        tools: ['update_issue_body'],
        providerConfig: {
          mcpServers: { docs: { type: 'http', url: 'https://mcp.example/docs' } },
        },
      }),
      'tmux-claude',
    )
    expect(mcpConfigFile).toBeDefined()
    const written = JSON.parse(await Bun.file(mcpConfigFile!).text())
    expect(written.mcpServers.docs).toEqual({ type: 'http', url: 'https://mcp.example/docs' })
    expect(written.mcpServers['ia-flow-tools']).toBeDefined()
  })

  it('does not add the synthetic mcp entry when the agent declares no tools', async () => {
    const { mcpConfigFile } = await buildClaudeCommand(baseInput(), 'tmux-claude')
    expect(mcpConfigFile).toBeUndefined()
  })
})
