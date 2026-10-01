import { describe, expect, it } from 'bun:test'
import { AgentDoc } from '@ia-flow/agent-engine-definitions'
import {
  BUILTIN_CAPABILITIES,
  BUILTIN_CAPABILITY_AGENTS,
  builtinCapabilityAgents,
} from './index.js'

const firstPrompt = (doc: Record<string, unknown>) =>
  ((doc.systemPrompts ?? []) as Array<{ id?: string; text?: string }>)[0]

describe('the runner capabilities', () => {
  it('every builtin agent is a valid agent document', () => {
    for (const doc of BUILTIN_CAPABILITY_AGENTS) {
      const parsed = AgentDoc.safeParse(doc)
      expect(parsed.success ? 'ok' : `${doc.id}: ${parsed.error.message}`).toBe('ok')
    }
  })

  it('each default capability is fulfilled by one of its agents', () => {
    const ids = BUILTIN_CAPABILITY_AGENTS.map((doc) => doc.id)
    expect(Object.keys(BUILTIN_CAPABILITIES).sort()).toEqual([
      'assistant',
      'branchName',
      'fileFocus',
      'whenText',
    ])
    for (const binding of Object.values(BUILTIN_CAPABILITIES)) expect(ids).toContain(binding.agent)
  })

  it('every builtin agent opens with the agentIdentity the config defines', () => {
    expect(BUILTIN_CAPABILITY_AGENTS.map((doc) => firstPrompt(doc))).toEqual(
      BUILTIN_CAPABILITY_AGENTS.map(() => ({ id: 'agentIdentity' })),
    )
    const declared = builtinCapabilityAgents(new Set(['agentIdentity']))
    expect(declared.map((doc) => firstPrompt(doc))).toEqual(
      BUILTIN_CAPABILITY_AGENTS.map(() => ({ id: 'agentIdentity' })),
    )
  })

  it('a config without agentIdentity runs them without it, instead of breaking the boot', () => {
    for (const doc of builtinCapabilityAgents(new Set())) {
      expect(firstPrompt(doc)?.text).toBeString()
      expect(AgentDoc.safeParse(doc).success).toBe(true)
    }
  })
})
