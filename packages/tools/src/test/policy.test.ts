import { describe, expect, it } from 'bun:test'
import '../fs/fs.js'
import '../write/write.js'
import '../exec/exec.js'
import '../workspace/workspace.js'
import '../task/task.js'

import { compilePolicy } from '../policy.js'

describe('compilePolicy', () => {
  it('returns an empty policy when tools[] is absent', () => {
    const p = compilePolicy({})
    expect(p.toolNames.size).toBe(0)
    expect(p.bashRun).toBeUndefined()
  })

  it('returns an empty policy for an empty tools[] array', () => {
    const p = compilePolicy({ tools: [] })
    expect(p.toolNames.size).toBe(0)
    expect(p.bashRun).toBeUndefined()
  })

  it('resolves plain string entries to canonical tool names', () => {
    const p = compilePolicy({ tools: ['fs_read', 'fs_write'] })
    expect(p.toolNames.has('fs_read')).toBe(true)
    expect(p.toolNames.has('fs_write')).toBe(true)
  })

  it('resolves legacy aliases to their canonical names', () => {
    const p = compilePolicy({ tools: ['read_file'] })
    expect(p.toolNames.has('fs_read')).toBe(true)
    expect(p.toolNames.has('read_file')).toBe(false)
  })

  it('adds the bash_run object entry to toolNames and exposes its config as bashRun', () => {
    const p = compilePolicy({
      tools: ['fs_read', { name: 'bash_run', allow: ['git status'], deny: ['git push*'] }],
    })
    expect(p.toolNames.has('bash_run')).toBe(true)
    expect(p.bashRun).toEqual({ name: 'bash_run', allow: ['git status'], deny: ['git push*'] })
  })

  it('an agent with only string entries has no bashRun config', () => {
    const p = compilePolicy({ tools: ['fs_read', 'task_write'] })
    expect(p.bashRun).toBeUndefined()
  })
})
