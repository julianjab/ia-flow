import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import {
  DEFAULT_TERMINAL_SETTINGS,
  loadProviderConfig,
  saveProviderConfig,
} from '../../application/provider-config.js'
import { promptRepo } from '../../composition/container.js'
import type { ProviderInput } from '../../domain/ports/IAgentProvider.js'
import { buildClaudeCommand } from './base.js'

let originalDbConfig: Record<string, unknown> | null = null

beforeAll(async () => {
  originalDbConfig = promptRepo.getProviderConfigBlob()
  const cfg = await loadProviderConfig()
  await saveProviderConfig({
    ...cfg,
    tmuxClaude: { ...DEFAULT_TERMINAL_SETTINGS },
    itermClaude: { ...DEFAULT_TERMINAL_SETTINGS },
  })
})

afterAll(() => {
  if (originalDbConfig !== null) promptRepo.setProviderConfigBlob(originalDbConfig)
  else promptRepo.deleteProviderConfigBlob()
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

describe('buildClaudeCommand — terminal per-agent providerConfig', () => {
  it('emits all flags when providerConfig sets model and dangerouslySkipPermissions', async () => {
    const { cmd, promptFile } = await buildClaudeCommand(
      baseInput({
        providerConfig: {
          model: 'claude-opus-4-7',
          dangerouslySkipPermissions: true,
        },
      }),
      'tmux-claude',
    )
    expect(cmd).toBe(
      `unset ANTHROPIC_API_KEY; claude --model claude-opus-4-7 --dangerously-skip-permissions < "${promptFile}"`,
    )
  })

  it('emits no flags when providerConfig is absent and no terminal defaults set', async () => {
    const { cmd, promptFile } = await buildClaudeCommand(baseInput(), 'iterm-claude')
    expect(cmd).toBe(`unset ANTHROPIC_API_KEY; claude < "${promptFile}"`)
  })

  it('emits only --dangerously-skip-permissions when only that flag is set', async () => {
    const { cmd, promptFile } = await buildClaudeCommand(
      baseInput({
        providerConfig: { dangerouslySkipPermissions: true },
      }),
      'tmux-claude',
    )
    expect(cmd).toBe(
      `unset ANTHROPIC_API_KEY; claude --dangerously-skip-permissions < "${promptFile}"`,
    )
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
        cwd: process.cwd(),
        workflow: 'branch',
      }),
      'tmux-claude',
    )
    expect(cmd).toContain('git checkout -b task/ABC123')
    expect(cmd).toContain('git checkout task/ABC123')
    expect(cmd).not.toContain('feat/')
  })

  it('implement + workflow=worktree → passes --worktree task/<taskId>', async () => {
    const { cmd } = await buildClaudeCommand(
      baseInput({
        step: 'implement',
        taskId: 'XYZ789',
        cwd: process.cwd(),
        workflow: 'worktree',
      }),
      'tmux-claude',
    )
    expect(cmd).toContain('--worktree task/XYZ789')
    expect(cmd).not.toContain('feat/')
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
    const { cmd, promptFile } = await buildClaudeCommand(
      baseInput({
        providerConfig: { effort: 'high', taskBudgetTokens: 30000 },
      }),
      'tmux-claude',
    )
    expect(cmd).toBe(`unset ANTHROPIC_API_KEY; claude < "${promptFile}"`)
  })
})
