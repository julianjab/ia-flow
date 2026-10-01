import { describe, expect, it } from 'bun:test'
import { BUILTIN_CAPABILITY_AGENTS } from '../capabilities/index.js'
import { RUNNER_SYSTEM_PROMPTS } from './index.js'

describe('the runner system prompts', () => {
  it('resolves its prompts by id, and nothing else', () => {
    expect(RUNNER_SYSTEM_PROMPTS.ids()).toEqual(['agentIdentity', 'untrusted-data'])
    expect(RUNNER_SYSTEM_PROMPTS.resolve('agentIdentity')).toContain('Claude Code')
    expect(RUNNER_SYSTEM_PROMPTS.resolve('nope')).toBeUndefined()
  })

  it('every id a runner capability names exists in the catalog', () => {
    const named = BUILTIN_CAPABILITY_AGENTS.flatMap((doc) =>
      ((doc.systemPrompts ?? []) as Array<{ id?: string; text?: string }>)
        .filter((ref) => ref.id !== undefined && ref.text === undefined)
        .map((ref) => `${doc.id}: ${ref.id}`),
    )
    expect(named.length).toBeGreaterThan(0)
    for (const entry of named) {
      expect(RUNNER_SYSTEM_PROMPTS.resolve(entry.split(': ')[1] as string)).toBeDefined()
    }
  })

  it('every runner capability opens with the agent identity', () => {
    const first = BUILTIN_CAPABILITY_AGENTS.map((doc) => [
      doc.id,
      ((doc.systemPrompts ?? []) as Array<{ id?: string }>)[0]?.id,
    ])
    expect(first).toEqual(BUILTIN_CAPABILITY_AGENTS.map((doc) => [doc.id, 'agentIdentity']))
  })
})
