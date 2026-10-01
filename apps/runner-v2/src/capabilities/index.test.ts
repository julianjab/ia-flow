import { describe, expect, it } from 'bun:test'
import { AgentDoc } from '@ia-flow/agent-engine-definitions'
import { BUILTIN_CAPABILITIES, BUILTIN_CAPABILITY_AGENTS } from './index.js'

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
      'assistant.runner-improvements',
      'branchName',
      'fileFocus',
      'whenText',
    ])
    for (const binding of Object.values(BUILTIN_CAPABILITIES)) expect(ids).toContain(binding.agent)
  })
})
