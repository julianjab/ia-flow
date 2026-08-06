import { describe, expect, it, beforeAll, afterAll } from 'bun:test'
import { buildClaudeCommand } from './terminal-provider-base.js'
import { saveProviderConfig, loadProviderConfig, DEFAULT_TERMINAL_SETTINGS } from './index.js'
import { getProviderConfigFromDb, setProviderConfigToDb, deleteProviderConfigFromDb } from '../db.js'
import type { StepInput } from './index.js'

let originalDbConfig: Record<string, unknown> | null = null

beforeAll(async () => {
  originalDbConfig = getProviderConfigFromDb()
  const cfg = await loadProviderConfig()
  await saveProviderConfig({
    ...cfg,
    tmuxClaude:  { ...DEFAULT_TERMINAL_SETTINGS },
    itermClaude: { ...DEFAULT_TERMINAL_SETTINGS },
  })
})

afterAll(() => {
  if (originalDbConfig !== null) setProviderConfigToDb(originalDbConfig)
  else deleteProviderConfigFromDb()
})

function baseInput(overrides: Partial<StepInput> = {}): StepInput {
  return {
    step: 'refine-functional',
    taskTitle: 'flag-test',
    taskDescription: 'd',
    taskType: 'feat',
    repos: [],
    contexts: [],
    prompt: 'hi',
    ...overrides,
  }
}

describe('buildClaudeCommand — terminal per-agent providerConfig', () => {
  it('emits all flags when providerConfig sets model, maxTurns, and dangerouslySkipPermissions', async () => {
    const { cmd, promptFile } = await buildClaudeCommand(
      baseInput({
        providerConfig: { provider: 'tmux-claude', model: 'claude-opus-4-7', maxTurns: 5, dangerouslySkipPermissions: true },
      }),
      'tmux-claude',
    )
    expect(cmd).toBe(`claude --model claude-opus-4-7 --max-turns 5 --dangerously-skip-permissions < "${promptFile}"`)
  })

  it('emits no flags when providerConfig is absent and no terminal defaults set', async () => {
    const { cmd, promptFile } = await buildClaudeCommand(
      baseInput(),
      'iterm-claude',
    )
    expect(cmd).toBe(`claude < "${promptFile}"`)
  })

  it('emits only --dangerously-skip-permissions when only that flag is set', async () => {
    const { cmd, promptFile } = await buildClaudeCommand(
      baseInput({
        providerConfig: { provider: 'tmux-claude', dangerouslySkipPermissions: true },
      }),
      'tmux-claude',
    )
    expect(cmd).toBe(`claude --dangerously-skip-permissions < "${promptFile}"`)
  })

  it('ignores a providerConfig for a different provider variant', async () => {
    const { cmd, promptFile } = await buildClaudeCommand(
      baseInput({
        providerConfig: { provider: 'anthropic-api', model: 'not-a-terminal-flag' } as any,
      }),
      'tmux-claude',
    )
    expect(cmd).toBe(`claude < "${promptFile}"`)
  })
})
