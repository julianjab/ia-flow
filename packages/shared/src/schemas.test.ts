import { describe, expect, it } from 'bun:test'
import {
  WhenConditionSchema,
  StatusAgentEntrySchema,
  StatusConfigSchema,
  ProjectConfigSchema,
} from './schemas.js'

// ─── WhenConditionSchema ─────────────────────────────────────────────────────

describe('WhenConditionSchema', () => {
  it('parses minimal condition (field + op only)', () => {
    const result = WhenConditionSchema.parse({ field: 'type', op: '=' })
    expect(result.field).toBe('type')
    expect(result.op).toBe('=')
    expect(result.value).toBeUndefined()
    expect(result.logic).toBeUndefined()
  })

  it('parses full condition with value and logic', () => {
    const result = WhenConditionSchema.parse({ field: 'type', op: '=', value: 'functional', logic: 'or' })
    expect(result).toEqual({ field: 'type', op: '=', value: 'functional', logic: 'or' })
  })

  it('accepts logic: and', () => {
    expect(() => WhenConditionSchema.parse({ field: 'f', op: '=', logic: 'and' })).not.toThrow()
  })

  it('rejects invalid logic value', () => {
    expect(() => WhenConditionSchema.parse({ field: 'f', op: '=', logic: 'xor' })).toThrow()
  })

  it('requires field', () => {
    expect(() => WhenConditionSchema.parse({ op: '=' })).toThrow()
  })

  it('requires op', () => {
    expect(() => WhenConditionSchema.parse({ field: 'type' })).toThrow()
  })
})

// ─── StatusAgentEntrySchema — when field ─────────────────────────────────────

describe('StatusAgentEntrySchema — when field', () => {
  it('parses entry without when (default agent)', () => {
    const result = StatusAgentEntrySchema.parse({ agent: 'my-agent' })
    expect(result.agent).toBe('my-agent')
    expect(result.when).toBeUndefined()
  })

  it('accepts legacy Record<string,string> when', () => {
    const result = StatusAgentEntrySchema.parse({
      agent: 'a',
      when: { type: 'functional', status: '$not_null' },
    })
    expect(result.when).toEqual({ type: 'functional', status: '$not_null' })
  })

  it('accepts new array when format', () => {
    const result = StatusAgentEntrySchema.parse({
      agent: 'a',
      when: [
        { field: 'type', op: '=', value: 'functional' },
        { field: 'type', op: '=', value: 'technical', logic: 'or' },
      ],
    })
    expect(Array.isArray(result.when)).toBe(true)
    expect((result.when as any[])[1].logic).toBe('or')
  })

  it('accepts all transition fields', () => {
    const result = StatusAgentEntrySchema.parse({
      agent: 'a',
      onProcess: '$set:status=refining',
      onFinish: '$set:status=done,type=technical',
      onError: 'queued',
    })
    expect(result.onProcess).toBe('$set:status=refining')
    expect(result.onFinish).toBe('$set:status=done,type=technical')
    expect(result.onError).toBe('queued')
  })

  it('omits undefined optional fields', () => {
    const result = StatusAgentEntrySchema.parse({ agent: 'a' })
    expect(result.onProcess).toBeUndefined()
    expect(result.onFinish).toBeUndefined()
    expect(result.onError).toBeUndefined()
  })
})

// ─── StatusConfigSchema ───────────────────────────────────────────────────────

describe('StatusConfigSchema', () => {
  it('parses minimal status config', () => {
    const result = StatusConfigSchema.parse({ name: 'queued', agents: [] })
    expect(result.name).toBe('queued')
    expect(result.agents).toEqual([])
  })

  it('parses status with context repos: task', () => {
    const result = StatusConfigSchema.parse({ name: 'queued', agents: [], context: { repos: 'task' } })
    expect(result.context?.repos).toBe('task')
  })

  it('parses status with context repos: all', () => {
    const result = StatusConfigSchema.parse({ name: 'queued', agents: [], context: { repos: 'all' } })
    expect(result.context?.repos).toBe('all')
  })

  it('parses status with context repos: string array', () => {
    const result = StatusConfigSchema.parse({ name: 'queued', agents: [], context: { repos: ['backend', 'frontend'] } })
    expect(result.context?.repos).toEqual(['backend', 'frontend'])
  })

  it('parses multiple agents with mixed when formats', () => {
    const result = StatusConfigSchema.parse({
      name: 'approved',
      agents: [
        { agent: 'decomposer', when: { type: 'functional' } },
        {
          agent: 'implementer',
          when: [
            { field: 'type', op: '=', value: 'technical' },
            { field: 'type', op: '=', value: 'functional', logic: 'or' },
          ],
        },
      ],
    })
    expect(result.agents).toHaveLength(2)
    expect(result.agents[0].agent).toBe('decomposer')
    expect(result.agents[1].agent).toBe('implementer')
  })
})

// ─── ProjectConfigSchema ──────────────────────────────────────────────────────

describe('ProjectConfigSchema', () => {
  it('parses empty config', () => {
    expect(() => ProjectConfigSchema.parse({})).not.toThrow()
  })

  it('parses full statuses array', () => {
    const result = ProjectConfigSchema.parse({
      statuses: [
        {
          name: 'queued',
          agents: [{ agent: 'orchestrator' }],
        },
        {
          name: 'approved',
          agents: [
            { agent: 'decomposer', when: { type: 'functional' }, onFinish: '$set:status=refining' },
            { agent: 'implementer', when: [{ field: 'type', op: '=', value: 'technical' }], onFinish: 'done' },
          ],
        },
      ],
    })
    expect(result.statuses).toHaveLength(2)
    expect(result.statuses![1].agents[0].onFinish).toBe('$set:status=refining')
  })

  it('rejects invalid repos type in context', () => {
    expect(() => ProjectConfigSchema.parse({
      statuses: [{ name: 'x', agents: [], context: { repos: 123 } }],
    })).toThrow()
  })
})
