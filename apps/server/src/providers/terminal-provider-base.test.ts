import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { promptRepo } from '../composition/container.js'
import { DEFAULT_TERMINAL_SETTINGS, loadProviderConfig, saveProviderConfig } from './index.js'
import type { StepInput } from './index.js'
import { buildClaudeCommand } from './terminal-provider-base.js'

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
      `claude --model claude-opus-4-7 --dangerously-skip-permissions < "${promptFile}"`,
    )
  })

  it('emits no flags when providerConfig is absent and no terminal defaults set', async () => {
    const { cmd, promptFile } = await buildClaudeCommand(baseInput(), 'iterm-claude')
    expect(cmd).toBe(`claude < "${promptFile}"`)
  })

  it('emits only --dangerously-skip-permissions when only that flag is set', async () => {
    const { cmd, promptFile } = await buildClaudeCommand(
      baseInput({
        providerConfig: { dangerouslySkipPermissions: true },
      }),
      'tmux-claude',
    )
    expect(cmd).toBe(`claude --dangerously-skip-permissions < "${promptFile}"`)
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
    expect(cmd).toBe(`claude < "${promptFile}"`)
  })
})
