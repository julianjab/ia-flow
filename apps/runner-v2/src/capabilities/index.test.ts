import { describe, expect, it } from 'bun:test'
import { AgentDoc } from '@ia-flow/agent-engine-definitions'
import { BUILTIN_CAPABILITIES, builtinCapabilityAgents } from './index.js'

describe('the runner capabilities', () => {
  it('every builtin agent is a valid agent document', () => {
    for (const doc of builtinCapabilityAgents()) {
      const parsed = AgentDoc.safeParse(doc)
      expect(parsed.success ? 'ok' : `${doc.id}: ${parsed.error.message}`).toBe('ok')
    }
  })

  it('each default capability is fulfilled by one of its agents', () => {
    const ids = builtinCapabilityAgents().map((doc) => doc.id)
    expect(Object.keys(BUILTIN_CAPABILITIES).sort()).toEqual([
      'assistant',
      'branchName',
      'fileFocus',
      'whenText',
    ])
    for (const binding of Object.values(BUILTIN_CAPABILITIES)) expect(ids).toContain(binding.agent)
  })

  it('the assistant gets the improvement repos as options of its tools', () => {
    const [assistant] = builtinCapabilityAgents({ engine: 'o/engine', config: 'o/config' })
    expect(assistant?.actions).toContainEqual({
      action: 'assistant',
      options: { engine: 'o/engine', config: 'o/config' },
    })
  })
})
