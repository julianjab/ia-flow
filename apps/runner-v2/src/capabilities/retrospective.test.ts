import { describe, expect, it } from 'bun:test'
import { AgentDoc, PipelineDoc } from '@ia-flow/agent-engine-definitions'
import { retrospectiveSource } from './retrospective.js'

describe('the retrospective', () => {
  it('its agent and its pipeline are valid documents', () => {
    const { agents, pipelines } = retrospectiveSource({
      enabled: true,
      repos: { engine: 'o/engine', config: 'o/deploy' },
    })
    for (const doc of agents) {
      const parsed = AgentDoc.safeParse(doc)
      expect(parsed.success ? 'ok' : parsed.error.message).toBe('ok')
    }
    for (const doc of pipelines) {
      const parsed = PipelineDoc.safeParse(doc)
      expect(parsed.success ? 'ok' : parsed.error.message).toBe('ok')
    }
  })

  it('off, it adds nothing', () => {
    expect(retrospectiveSource({ enabled: false, repos: {} })).toEqual({
      agents: [],
      pipelines: [],
    })
  })
})
