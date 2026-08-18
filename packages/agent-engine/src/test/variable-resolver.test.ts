import { describe, expect, it } from 'bun:test'
import type { AgentToolEntry } from '@ia-flow/shared'
import { resolveBashRunPatterns, resolveVariables } from '../variable-resolver.js'
import type { ResolveContext, ResolveVariable } from '../variable-resolver.js'

const task = { id: 't1', title: 'Fix bug', description: '', type: 'functional', repos: [] }
const baseCtx: ResolveContext = { task }

const resolve: ResolveVariable = (path, ctx) => {
  if (path === 'task.branch') return `task/${ctx.task.id}`
  if (path === 'task.title') return ctx.task.title
  return undefined
}

describe('resolveVariables', () => {
  it('substitutes a known {{...}} path', () => {
    expect(resolveVariables('git push origin {{task.branch}}', baseCtx, resolve)).toBe(
      'git push origin task/t1',
    )
  })

  it('leaves unknown variables as-is', () => {
    expect(resolveVariables('{{nope.here}}', baseCtx, resolve)).toBe('{{nope.here}}')
  })
})

describe('resolveBashRunPatterns', () => {
  it('returns undefined/empty untouched', () => {
    expect(resolveBashRunPatterns(undefined, baseCtx, resolve)).toBeUndefined()
    expect(resolveBashRunPatterns([], baseCtx, resolve)).toEqual([])
  })

  it('leaves plain string tool entries untouched', () => {
    const tools: AgentToolEntry[] = ['fs_read', 'task_write']
    expect(resolveBashRunPatterns(tools, baseCtx, resolve)).toEqual(['fs_read', 'task_write'])
  })

  it('resolves {{...}} inside allow and deny patterns of the bash_run entry', () => {
    const tools: AgentToolEntry[] = [
      'fs_read',
      {
        name: 'bash_run',
        allow: ['git push origin {{task.branch}}'],
        deny: ['git push origin main {{task.branch}}'],
      },
    ]
    expect(resolveBashRunPatterns(tools, baseCtx, resolve)).toEqual([
      'fs_read',
      {
        name: 'bash_run',
        allow: ['git push origin task/t1'],
        deny: ['git push origin main task/t1'],
      },
    ])
  })

  it('throws when a variable inside a pattern is unknown — never leaves a dead/inert deny rule', () => {
    const tools: AgentToolEntry[] = [
      { name: 'bash_run', allow: ['git status'], deny: ['{{nope.here}}'] },
    ]
    expect(() => resolveBashRunPatterns(tools, baseCtx, resolve)).toThrow(
      /unknown or empty variable/,
    )
  })

  it('throws when a variable resolves to an empty/blank string — same silent-deny-drop risk as undefined', () => {
    // Mirrors the real catalog (apps/server/src/variables/{custom,task}.ts),
    // which returns '' for unknown keys instead of undefined.
    const resolveBlank: ResolveVariable = () => ''
    const tools: AgentToolEntry[] = [
      {
        name: 'bash_run',
        allow: ['git status'],
        deny: ['git push origin {{variables.protected_branch}}'],
      },
    ]
    expect(() => resolveBashRunPatterns(tools, baseCtx, resolveBlank)).toThrow(
      /unknown or empty variable/,
    )
  })

  it('throws when a resolved value contains whitespace or "*" — refuses to widen the pattern', () => {
    const withSpace: ResolveVariable = () => 'evil value'
    const withStar: ResolveVariable = () => '*'
    const tools: AgentToolEntry[] = [
      { name: 'bash_run', allow: ['git push origin {{task.branch}}'], deny: [] },
    ]
    expect(() => resolveBashRunPatterns(tools, baseCtx, withSpace)).toThrow(/whitespace or "\*"/)
    expect(() => resolveBashRunPatterns(tools, baseCtx, withStar)).toThrow(/whitespace or "\*"/)
  })

  it('does not mutate the input array/entries', () => {
    const bashEntry = {
      name: 'bash_run' as const,
      allow: ['git push origin {{task.branch}}'],
      deny: [],
    }
    const tools: AgentToolEntry[] = [bashEntry]
    const resolved = resolveBashRunPatterns(tools, baseCtx, resolve)
    expect(bashEntry.allow).toEqual(['git push origin {{task.branch}}'])
    expect(resolved).not.toBe(tools)
    expect(resolved?.[0]).not.toBe(bashEntry)
  })

  it('an agent with no bash_run entry is unaffected', () => {
    const tools: AgentToolEntry[] = ['fs_read', 'fs_write']
    const resolved = resolveBashRunPatterns(tools, baseCtx, resolve)
    expect(resolved).toEqual(tools)
  })
})
