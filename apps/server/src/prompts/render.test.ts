import { describe, expect, it } from 'bun:test'
import type { ProviderConfig } from '@ia-flow/shared'
import { renderPhasePrompt, substituteVars } from './render.js'
import { DEFAULT_PHASE_PROMPTS } from './defaults.js'
import { DEFAULT_ANTHROPIC_SETTINGS } from '../providers/index.js'

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    steps: {
      'refine-functional': 'anthropic-api',
      'refine-technical': 'anthropic-api',
      'implement': 'tmux-claude',
    },
    anthropicApi: DEFAULT_ANTHROPIC_SETTINGS,
    phasePrompts: {},
    ...overrides,
  }
}

const baseVars = {
  task_title: 'My Task',
  task_description: 'Do the thing',
  task_type: 'functional',
  repos: 'alpha, beta',
  checkbox_answers: '',
  comments: '',
  contexts: '### Repo: alpha',
  response_language: 'english',
}

describe('renderPhasePrompt', () => {
  it('uses the default template when no override is saved', () => {
    const config = makeConfig()
    const rendered = renderPhasePrompt('refine-functional', config, baseVars)
    // Substituted placeholders
    expect(rendered).toContain('Title: My Task')
    expect(rendered).toContain('Selected repos: alpha, beta')
    expect(rendered).toContain('Responde en english.')
    // No leftover placeholders that we supplied values for
    expect(rendered).not.toContain('{task_title}')
    expect(rendered).not.toContain('{response_language}')
    // Anchor to the default template
    expect(rendered.startsWith(DEFAULT_PHASE_PROMPTS['refine-functional'].slice(0, 30))).toBe(true)
  })

  it('uses the override prompt when saved for the step', () => {
    const config = makeConfig({
      phasePrompts: { implement: 'Custom {task_title}' },
    })
    const rendered = renderPhasePrompt('implement', config, { task_title: 'Foo' })
    expect(rendered).toBe('Custom Foo')
  })

  it('embeds the response language in the default prompt', () => {
    const config = makeConfig({
      anthropicApi: { ...DEFAULT_ANTHROPIC_SETTINGS, responseLanguage: 'español' },
    })
    const rendered = renderPhasePrompt('refine-technical', config, {
      ...baseVars,
      response_language: 'español',
    })
    expect(rendered).toContain('Responde en español.')
  })

  it('preserves unknown placeholders instead of throwing', () => {
    const config = makeConfig({
      phasePrompts: { 'refine-functional': 'hello {not_a_variable} world {task_title}' },
    })
    const rendered = renderPhasePrompt('refine-functional', config, { task_title: 'X' })
    expect(rendered).toBe('hello {not_a_variable} world X')
  })

  it('treats empty-string overrides as "use default"', () => {
    const config = makeConfig({ phasePrompts: { 'refine-functional': '   ' } })
    const rendered = renderPhasePrompt('refine-functional', config, baseVars)
    expect(rendered).toContain('Responde en english.')
  })
})

describe('in-flight prompt snapshot', () => {
  it('a resolved prompt is not affected by later config mutations', () => {
    // Simulates the orchestrator pattern: config is loaded and rendered BEFORE
    // provider.run. Even if the underlying config object is mutated afterward,
    // the prompt already passed to provider.run is a plain string and does not
    // re-resolve.
    const config = makeConfig({
      phasePrompts: { implement: 'v1 {task_title}' },
    })
    const rendered = renderPhasePrompt('implement', config, { task_title: 'Foo' })

    // Config file is "overwritten" (simulated by mutating the object).
    config.phasePrompts = { implement: 'v2 {task_title}' }

    // The already-captured prompt is unchanged.
    expect(rendered).toBe('v1 Foo')
  })
})

describe('substituteVars', () => {
  it('replaces known placeholders and leaves unknown ones intact', () => {
    expect(substituteVars('{a} {b} {c}', { a: '1', c: '3' })).toBe('1 {b} 3')
  })
})
