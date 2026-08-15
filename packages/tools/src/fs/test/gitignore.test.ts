import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _clearGitignoreCache, isIgnored } from './gitignore.js'

let repoRoot: string

beforeEach(() => {
  _clearGitignoreCache()
  repoRoot = mkdtempSync(join(tmpdir(), 'ia-flow-git-'))
})

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
})

describe('isIgnored', () => {
  it('returns false when no .gitignore exists and path is not .git', () => {
    writeFileSync(join(repoRoot, 'a.txt'), 'x')
    expect(isIgnored(join(repoRoot, 'a.txt'), { r: repoRoot })).toBe(false)
  })

  it('honors patterns from the root .gitignore', () => {
    writeFileSync(join(repoRoot, '.gitignore'), 'dist\n*.log\n')
    mkdirSync(join(repoRoot, 'dist'))
    writeFileSync(join(repoRoot, 'dist/bundle.js'), 'x')
    writeFileSync(join(repoRoot, 'debug.log'), 'x')
    writeFileSync(join(repoRoot, 'index.ts'), 'x')

    const repos = { r: repoRoot }
    expect(isIgnored(join(repoRoot, 'dist'), repos)).toBe(true)
    expect(isIgnored(join(repoRoot, 'dist/bundle.js'), repos)).toBe(true)
    expect(isIgnored(join(repoRoot, 'debug.log'), repos)).toBe(true)
    expect(isIgnored(join(repoRoot, 'index.ts'), repos)).toBe(false)
  })

  it('always ignores .git even without a .gitignore', () => {
    expect(isIgnored(join(repoRoot, '.git'), { r: repoRoot })).toBe(true)
    expect(isIgnored(join(repoRoot, '.git/HEAD'), { r: repoRoot })).toBe(true)
  })

  it('returns false for paths outside any registered repo', () => {
    writeFileSync(join(repoRoot, '.gitignore'), '*.log\n')
    expect(isIgnored('/tmp/some/other/path/x.log', { r: repoRoot })).toBe(false)
  })

  it('respects negation patterns', () => {
    writeFileSync(join(repoRoot, '.gitignore'), '*.log\n!keep.log\n')
    const repos = { r: repoRoot }
    expect(isIgnored(join(repoRoot, 'a.log'), repos)).toBe(true)
    expect(isIgnored(join(repoRoot, 'keep.log'), repos)).toBe(false)
  })

  it('never marks the repo root itself as ignored', () => {
    writeFileSync(join(repoRoot, '.gitignore'), '*\n')
    expect(isIgnored(repoRoot, { r: repoRoot })).toBe(false)
  })
})
