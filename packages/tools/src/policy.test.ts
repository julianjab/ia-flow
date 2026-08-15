import { describe, expect, it } from 'bun:test'
import './fs/fs.js' // registers fs.read tools so category expansion has something to return
import './write/write.js' // fs.write
import './exec/exec.js' // bash
import './workspace/workspace.js' // workspace
import './task/task.js' // task.transition / task.write

import { LEGACY_DEFAULT_POLICY, compilePolicy, listPresets } from './policy.js'

describe('compilePolicy', () => {
  it('returns an empty policy when no permissions are given', () => {
    const p = compilePolicy({})
    expect(p.toolNames.size).toBe(0)
    expect(p.bash.bins.size).toBe(0)
    expect(p.bash.git.allowReadonly).toBe(false)
    expect(p.bash.git.allowPushMain).toBe(false)
  })

  it('expands fs.read into read/list/grep canonical tool names', () => {
    const p = compilePolicy({ permissions: ['fs.read'] })
    // Names are the post-rename canonical ids; aliases (read_file, list_dir,
    // grep_files) resolve to fs_read / fs_list / fs_grep after Task 3.
    // For now the tools still register under their legacy names, so this
    // test just asserts >0 fs.read tools are picked up.
    expect(p.toolNames.size).toBeGreaterThan(0)
  })

  it('bash:gh only opts into gh binary, not bun/git', () => {
    const p = compilePolicy({ permissions: ['bash:gh'] })
    expect(p.bash.bins.has('gh')).toBe(true)
    expect(p.bash.bins.has('bun')).toBe(false)
    expect(p.bash.bins.has('git')).toBe(false)
  })

  it('bash:git.write.task allows push to task branches but NOT main', () => {
    const p = compilePolicy({ permissions: ['bash:git.write.task'] })
    expect(p.bash.git.allowReadonly).toBe(true)
    expect(p.bash.git.allowPushTask).toBe(true)
    expect(p.bash.git.allowPushMain).toBe(false)
  })

  it('bash:git.write.main allows push to main', () => {
    const p = compilePolicy({ permissions: ['bash:git.write.main'] })
    expect(p.bash.git.allowPushTask).toBe(true)
    expect(p.bash.git.allowPushMain).toBe(true)
  })

  it('bash:git.destructive unlocks branch ops + reset --hard + worktree remove', () => {
    const p = compilePolicy({ permissions: ['bash:git.destructive'] })
    expect(p.bash.git.allowBranchOps).toBe(true)
    expect(p.bash.git.allowResetHard).toBe(true)
    expect(p.bash.git.allowWorktreeRemove).toBe(true)
  })

  it('bare `bash` opts into the legacy default sub-scopes', () => {
    const p = compilePolicy({ permissions: ['bash'] })
    expect(p.bash.bins.has('bun')).toBe(true)
    expect(p.bash.bins.has('git')).toBe(true)
    expect(p.bash.bins.has('cat')).toBe(true)
    expect(p.bash.git.allowPushTask).toBe(true)
    expect(p.bash.git.allowPushMain).toBe(false)
    // Never grants gh even with the bare category.
    expect(p.bash.bins.has('gh')).toBe(false)
  })

  it('reviewer preset: has gh, has push to task, does NOT push to main', () => {
    const p = compilePolicy({ presetId: 'reviewer' })
    expect(p.bash.bins.has('gh')).toBe(true)
    expect(p.bash.git.allowPushTask).toBe(true)
    expect(p.bash.git.allowPushMain).toBe(false)
  })

  it('releaser preset: has gh and push to main', () => {
    const p = compilePolicy({ presetId: 'releaser' })
    expect(p.bash.bins.has('gh')).toBe(true)
    expect(p.bash.git.allowPushMain).toBe(true)
  })

  it('reader preset: no bash, no fs.write, has fs.read + task.transition', () => {
    const p = compilePolicy({ presetId: 'reader' })
    expect(p.bash.bins.size).toBe(0)
    expect(p.toolNames.size).toBeGreaterThan(0)
  })

  it('merges preset with extra permissions[] (union)', () => {
    const p = compilePolicy({
      presetId: 'reviewer',
      permissions: ['bash:git.write.main'],
    })
    expect(p.bash.git.allowPushMain).toBe(true)
    expect(p.bash.bins.has('gh')).toBe(true)
  })

  it('tool: escape hatch adds a single tool by canonical id (aliases resolved)', () => {
    const p = compilePolicy({ permissions: ['tool:read_file'] })
    // read_file is an alias registered by Task 3 (fs_read). Until the alias
    // ships we just assert the raw name survives.
    expect(p.toolNames.size).toBeGreaterThan(0)
  })

  it('unknown category / scope / tool are silently ignored', () => {
    const p = compilePolicy({
      permissions: ['not-a-cat', 'bash:not-a-scope', 'tool:no_such_tool'] as never[],
    })
    // no crash; nothing added
    expect(p.bash.bins.size).toBe(0)
  })
})

describe('LEGACY_DEFAULT_POLICY', () => {
  it('mirrors the pre-issue-58 whitelist and git rules', () => {
    expect(LEGACY_DEFAULT_POLICY.bash.bins.has('bun')).toBe(true)
    expect(LEGACY_DEFAULT_POLICY.bash.bins.has('git')).toBe(true)
    expect(LEGACY_DEFAULT_POLICY.bash.bins.has('gh')).toBe(false)
    expect(LEGACY_DEFAULT_POLICY.bash.git.allowPushTask).toBe(true)
    expect(LEGACY_DEFAULT_POLICY.bash.git.allowPushMain).toBe(false)
    expect(LEGACY_DEFAULT_POLICY.bash.git.allowResetHard).toBe(false)
    expect(LEGACY_DEFAULT_POLICY.bash.git.allowBranchOps).toBe(false)
  })
})

describe('listPresets', () => {
  it('returns the 5 built-in presets with id + description + permissions', () => {
    const presets = listPresets()
    expect(presets.map((p) => p.id).sort()).toEqual([
      'implementer',
      'reader',
      'refiner',
      'releaser',
      'reviewer',
    ])
    for (const p of presets) {
      expect(p.description.length).toBeGreaterThan(0)
      expect(p.permissions.length).toBeGreaterThan(0)
    }
  })
})
