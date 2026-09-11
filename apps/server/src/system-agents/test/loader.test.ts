import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'bun:test'
import { loadBaseAgents } from '../loader.js'

const BASE_AGENTS_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'base-agents.yaml')

describe('loadBaseAgents', () => {
  test('parsea base-agents.yaml contra AgentDefinitionSchema/RuleSchema', () => {
    const config = loadBaseAgents(BASE_AGENTS_PATH)
    expect(config.agents.map((a) => a.id)).toContain('chat-assistant')
    expect(config.rules.map((r) => r.id)).toContain('chat-assistant-on-message')
  })

  test('la regla fija dispara al agente correcto sobre chat.message', () => {
    const config = loadBaseAgents(BASE_AGENTS_PATH)
    const rule = config.rules.find((r) => r.id === 'chat-assistant-on-message')
    expect(rule?.on).toEqual(['chat.message'])
    expect(rule?.do).toEqual([{ action: 'agent', agentId: 'chat-assistant' }])
  })

  test('tira un error legible con un archivo inexistente', () => {
    expect(() => loadBaseAgents('/no/existe/base-agents.yaml')).toThrow(/No se pudo leer/)
  })
})
