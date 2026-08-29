import { describe, expect, it } from 'bun:test'
import {
  AgentDefinitionSchema,
  AnthropicApiSettingsSchema,
  ProjectConfigSchema,
  ProviderConfigSchema,
  TaskSchema,
  WhenConditionSchema,
} from '../schemas.js'
import type {
  AgentActivation,
  AgentDefinition,
  AgentOutcomes,
  AnthropicApiSettings,
  ProjectConfig,
  ProviderConfig,
  Task,
  WhenCondition,
  WsMessage,
} from '../types.js'

// types.ts re-exports inferred types from schemas — verify the inferred shapes
// match expected structural contracts so any accidental schema change is caught.

describe('WhenCondition type', () => {
  it('inferred type satisfies WhenCondition interface', () => {
    const cond: WhenCondition = WhenConditionSchema.parse({
      field: 'type',
      op: '=',
      value: 'functional',
      logic: 'and',
    })
    expect(cond.field).toBe('type')
    expect(cond.op).toBe('=')
    expect(cond.value).toBe('functional')
    expect(cond.logic).toBe('and')
  })

  it('optional fields are absent when not provided', () => {
    const cond: WhenCondition = WhenConditionSchema.parse({ field: 'f', op: '$null' })
    expect('value' in cond).toBe(false)
    expect('logic' in cond).toBe(false)
  })
})

describe('AgentDefinition — activación y outcomes', () => {
  const base = { id: 'my-agent', provider: 'anthropic-api', prompt: 'do the thing' }

  it('agent with array when is typed correctly', () => {
    const agent: AgentDefinition = AgentDefinitionSchema.parse({
      ...base,
      when: [
        { field: 'type', op: '=', value: 'functional' },
        { field: 'type', op: '=', value: 'technical', logic: 'or' },
      ],
      exits: { success: '$set:status=done' },
    })
    expect(agent.id).toBe('my-agent')
    expect(Array.isArray(agent.when)).toBe(true)
    expect(agent.exits?.success).toBe('$set:status=done')
  })

  it('agent with legacy record when is typed correctly', () => {
    const agent: AgentDefinition = AgentDefinitionSchema.parse({
      ...base,
      when: { type: 'functional' },
    })
    expect(Array.isArray(agent.when)).toBe(false)
    expect((agent.when as Record<string, string>)['type']).toBe('functional')
  })

  it('agent without activation fields is unrestricted (candidato en todo)', () => {
    const agent: AgentDefinition = AgentDefinitionSchema.parse(base)
    expect(agent.when).toBeUndefined()
    expect(agent.repoName).toBeUndefined()
    expect(agent.statusName).toBeUndefined()
    expect(agent.onProcess).toBeUndefined()
    expect(agent.exits).toBeUndefined()
  })

  it('AgentActivation / AgentOutcomes son subconjuntos asignables de AgentDefinition', () => {
    const agent: AgentDefinition = AgentDefinitionSchema.parse({
      ...base,
      statusName: 'Build',
      repoName: 'backend',
      exits: { error: 'queued' },
    })
    const activation: AgentActivation = agent
    const outcomes: AgentOutcomes = agent
    expect(activation.statusName).toBe('Build')
    expect(outcomes.exits?.error).toBe('queued')
  })
})

// ─── Task type ────────────────────────────────────────────────────────────────

describe('Task type', () => {
  it('inferred Task has all required fields', () => {
    const task: Task = TaskSchema.parse({
      id: 'task-1',
      title: 'Feature',
      description: 'desc',
      type: 'functional',
      repos: ['backend'],
      status: 'queued',
      created_at: '2025-01-01T00:00:00Z',
    })
    expect(task.id).toBe('task-1')
    expect(task.type).toBe('functional')
    expect(task.status).toBe('queued')
    expect(task.prd).toBeUndefined()
  })

  it('Task optional fields are absent when not provided', () => {
    const task: Task = TaskSchema.parse({
      id: 't',
      title: 't',
      description: 'd',
      type: 'technical',
      repos: [],
      status: 'approved',
      created_at: '2025-01-01T00:00:00Z',
    })
    expect(task.approved_at).toBeUndefined()
    expect(task.agent_working).toBeUndefined()
    expect(task.issueNumber).toBeUndefined()
  })
})

// ─── AnthropicApiSettings type ────────────────────────────────────────────────

describe('AnthropicApiSettings type', () => {
  it('inferred type has expected shape', () => {
    const settings: AnthropicApiSettings = AnthropicApiSettingsSchema.parse({
      model: 'claude-sonnet-4-5',
      anthropicVersion: '2023-06-01',
      anthropicBeta: ['computer-use-2024-10-22'],
      systemPrompt: [{ type: 'text', text: 'You are helpful' }],
      stream: true,
      responseLanguage: 'es',
    })
    expect(settings.anthropicBeta).toContain('computer-use-2024-10-22')
    expect(settings.systemPrompt[0].type).toBe('text')
  })
})

// ─── ProviderConfig type ──────────────────────────────────────────────────────

describe('ProviderConfig type', () => {
  it('inferred type includes optional repoMappings', () => {
    const config: ProviderConfig = ProviderConfigSchema.parse({
      steps: {
        'refine-functional': 'anthropic-api',
        'refine-technical': 'anthropic-api',
        implement: 'anthropic-api',
      },
      anthropicApi: {
        model: 'claude-sonnet-4-5',
        anthropicVersion: '2023-06-01',
        anthropicBeta: [],
        systemPrompt: [{ type: 'text', text: 'sys' }],
      },
      repoMappings: { backend: 'my-backend' },
    })
    expect(config.repoMappings?.['backend']).toBe('my-backend')
  })
})

// ─── ProjectConfig type ───────────────────────────────────────────────────────

describe('ProjectConfig type', () => {
  it('all fields are optional in ProjectConfig', () => {
    const config: ProjectConfig = ProjectConfigSchema.parse({})
    expect(config.project).toBeUndefined()
    expect(config.agents).toBeUndefined()
    expect(config.statuses).toBeUndefined()
    // `repos` no está en ProjectConfig desde la migración 011: viven en su
    // propia tabla, no en el bag de config del proyecto.
  })
})

// ─── WsMessage type ───────────────────────────────────────────────────────────

describe('WsMessage type', () => {
  it('task:created message shape is correct', () => {
    const task: Task = TaskSchema.parse({
      id: 't1',
      title: 'T',
      description: 'd',
      type: 'functional',
      repos: [],
      status: 'queued',
      created_at: '2025-01-01T00:00:00Z',
    })
    const msg: WsMessage = { type: 'task:created', task }
    expect(msg.type).toBe('task:created')
  })

  it('tasks:snapshot message shape is correct', () => {
    const msg: WsMessage = { type: 'tasks:snapshot', tasks: [] }
    expect(msg.type).toBe('tasks:snapshot')
    expect(msg.tasks).toEqual([])
  })
})
