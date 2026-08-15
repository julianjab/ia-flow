import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getTool } from '../engine.js'
import { _grepInternals, grepWithJs } from './fs.js'
import { _clearGitignoreCache } from './gitignore.js'
import './fs.js' // side-effect: register list_dir / grep_files

let repoRoot: string
let repoPaths: Record<string, string>

beforeEach(() => {
  _clearGitignoreCache()
  repoRoot = mkdtempSync(join(tmpdir(), 'ia-flow-fs-'))
  repoPaths = { r: repoRoot }
})

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
})

describe('list_dir honors .gitignore', () => {
  it('excludes files matching root .gitignore patterns', async () => {
    writeFileSync(join(repoRoot, '.gitignore'), 'ignored.txt\nbuild\n')
    writeFileSync(join(repoRoot, 'ignored.txt'), 'x')
    writeFileSync(join(repoRoot, 'kept.txt'), 'x')
    mkdirSync(join(repoRoot, 'build'))
    mkdirSync(join(repoRoot, 'src'))

    const tool = getTool('list_dir')!
    const out = await tool.execute({ path: 'r' }, { repoPaths })
    expect(out).toContain('f kept.txt')
    expect(out).toContain('d src')
    expect(out).not.toContain('ignored.txt')
    expect(out).not.toContain('build')
  })
})

describe('grep_files honors .gitignore', () => {
  it('skips ignored files and directories during the walk', async () => {
    writeFileSync(join(repoRoot, '.gitignore'), 'secrets.txt\nbuild\n')
    writeFileSync(join(repoRoot, 'secrets.txt'), 'TOKEN=hunter2')
    writeFileSync(join(repoRoot, 'app.ts'), 'const TOKEN = "hunter2"')
    mkdirSync(join(repoRoot, 'build'))
    writeFileSync(join(repoRoot, 'build/bundle.js'), 'TOKEN=hunter2')

    const tool = getTool('grep_files')!
    const out = await tool.execute({ path: 'r', pattern: 'TOKEN' }, { repoPaths })
    expect(out).toContain('app.ts')
    expect(out).not.toContain('secrets.txt')
    expect(out).not.toContain('bundle.js')
  })
})

/**
 * Parse the joined execute() output back into `<repo>/<path>:<line>` keys
 * so we can compare rg and JS results as sets (order-independent).
 */
function extractMatchKeys(output: string): string[] {
  return output
    .split('\n')
    .filter((l) => l.includes(':') && !l.startsWith('['))
    .map((l) => {
      const [pathAndLine] = l.split(': ')
      // pathAndLine is `<repo>/<path>:<line>`
      return pathAndLine
    })
    .sort()
}

describe('grep_files — rg backend', () => {
  it('produces parity output with the JS walk on the same fixtures', async () => {
    writeFileSync(join(repoRoot, '.gitignore'), 'ignored.log\n')
    writeFileSync(join(repoRoot, 'a.ts'), 'const NEEDLE = 1\nfoo\nsecond NEEDLE hit\nmore')
    mkdirSync(join(repoRoot, 'sub'))
    writeFileSync(join(repoRoot, 'sub/b.ts'), 'first line\nNEEDLE at sub\n')
    writeFileSync(join(repoRoot, 'ignored.log'), 'NEEDLE in ignored\n')
    mkdirSync(join(repoRoot, 'node_modules'))
    writeFileSync(join(repoRoot, 'node_modules/dep.js'), 'NEEDLE in dep\n')

    const tool = getTool('grep_files')!
    const backendOut = await tool.execute({ path: 'r', pattern: 'NEEDLE' }, { repoPaths })
    const jsResults = await grepWithJs({ path: 'r', pattern: 'NEEDLE' }, { repoPaths })
    const jsOut = jsResults.join('\n')

    const backendKeys = extractMatchKeys(backendOut)
    const jsKeys = extractMatchKeys(jsOut)

    expect(backendKeys.length).toBeGreaterThan(0)
    expect(backendKeys).toEqual(jsKeys)
    // Both backends must exclude ignored + node_modules matches
    expect(backendOut).not.toContain('ignored.log')
    expect(backendOut).not.toContain('node_modules')
  })

  it('respects case_insensitive and glob flags (parity)', async () => {
    writeFileSync(join(repoRoot, 'lower.ts'), 'needle here\n')
    writeFileSync(join(repoRoot, 'upper.ts'), 'NEEDLE here\n')
    writeFileSync(join(repoRoot, 'other.md'), 'NEEDLE in md\n')

    const tool = getTool('grep_files')!
    const backendOut = await tool.execute(
      { path: 'r', pattern: 'needle', case_insensitive: true, glob: '*.ts' },
      { repoPaths },
    )
    const jsResults = await grepWithJs(
      { path: 'r', pattern: 'needle', case_insensitive: true, glob: '*.ts' },
      { repoPaths },
    )

    const backendKeys = extractMatchKeys(backendOut)
    const jsKeys = extractMatchKeys(jsResults.join('\n'))
    expect(backendKeys).toEqual(jsKeys)
    expect(backendOut).not.toContain('other.md')
  })

  it('restricts search to a single file when path targets a file (parity)', async () => {
    // Two files in the same directory. Passing the file path must only
    // yield matches from that file, never from its sibling — this is the
    // rg semantics we now enforce for the JS fallback too.
    writeFileSync(join(repoRoot, 'a.ts'), 'HIT in a\nno match\nHIT again in a\n')
    writeFileSync(join(repoRoot, 'b.ts'), 'HIT in b\n')

    const tool = getTool('grep_files')!
    const backendOut = await tool.execute({ path: 'r/a.ts', pattern: 'HIT' }, { repoPaths })
    const jsResults = await grepWithJs({ path: 'r/a.ts', pattern: 'HIT' }, { repoPaths })

    expect(backendOut).toContain('a.ts')
    expect(backendOut).not.toContain('b.ts')
    expect(extractMatchKeys(backendOut)).toEqual(extractMatchKeys(jsResults.join('\n')))
    // Also confirm the JS fallback in isolation is scoped to the single file.
    expect(jsResults.every((r) => r.includes('a.ts'))).toBe(true)
    expect(jsResults.some((r) => r.includes('b.ts'))).toBe(false)
  })

  it('handles globs with multiple wildcards (parity)', async () => {
    // Regression for the `.replace('*', '.*')` bug: without the /g flag
    // the JS backend converted `*.test.ts` into `.*test.ts`, leaving the
    // second wildcard as a literal `*` and silently skipping every real
    // `foo.test.ts` file. rg (via ripgrep's glob parser) always matched
    // them, so parity broke.
    writeFileSync(join(repoRoot, 'foo.test.ts'), 'MULTI hit\n')
    writeFileSync(join(repoRoot, 'bar.test.ts'), 'MULTI hit\n')
    writeFileSync(join(repoRoot, 'plain.ts'), 'MULTI hit\n')
    writeFileSync(join(repoRoot, 'notes.md'), 'MULTI hit\n')

    const tool = getTool('grep_files')!
    const backendOut = await tool.execute(
      { path: 'r', pattern: 'MULTI', glob: '*.test.ts' },
      { repoPaths },
    )
    const jsResults = await grepWithJs(
      { path: 'r', pattern: 'MULTI', glob: '*.test.ts' },
      { repoPaths },
    )

    expect(backendOut).toContain('foo.test.ts')
    expect(backendOut).toContain('bar.test.ts')
    expect(backendOut).not.toContain('plain.ts')
    expect(backendOut).not.toContain('notes.md')

    // JS backend must find both `.test.ts` files (the bug caused zero).
    expect(jsResults.length).toBe(2)
    expect(jsResults.every((r) => r.includes('.test.ts'))).toBe(true)

    expect(extractMatchKeys(backendOut)).toEqual(extractMatchKeys(jsResults.join('\n')))
  })

  it('glob is anchored — *.ts does not match foo.tsx or names containing ts', async () => {
    // Regression for the un-anchored glob→regex bug. Pre-fix, `*.ts`
    // was translated to `.*ts` (no anchors, `.` not escaped) and via
    // String.prototype.match returned truthy on ANY name containing the
    // substring `ts` — including `foo.tsx` and `notes-tsdoc.md`.
    // rg (via ripgrep's glob parser) always anchored correctly, so the
    // parity broke silently.
    writeFileSync(join(repoRoot, 'foo.ts'), 'ANCHOR hit\n')
    writeFileSync(join(repoRoot, 'foo.tsx'), 'ANCHOR hit\n')
    writeFileSync(join(repoRoot, 'notes-tsdoc.md'), 'ANCHOR hit\n')

    const tool = getTool('grep_files')!
    const backendOut = await tool.execute(
      { path: 'r', pattern: 'ANCHOR', glob: '*.ts' },
      { repoPaths },
    )
    const jsResults = await grepWithJs(
      { path: 'r', pattern: 'ANCHOR', glob: '*.ts' },
      { repoPaths },
    )

    expect(backendOut).toContain('foo.ts')
    expect(backendOut).not.toContain('foo.tsx')
    expect(backendOut).not.toContain('notes-tsdoc')

    // JS backend must match exactly one file (the bug leaked all three).
    expect(jsResults.length).toBe(1)
    expect(jsResults.every((r) => r.includes('/foo.ts:'))).toBe(true)

    expect(extractMatchKeys(backendOut)).toEqual(extractMatchKeys(jsResults.join('\n')))
  })
})

describe('grep_files — fallback JS', () => {
  it('falls back to the JS walk when rg is not available on PATH', async () => {
    // Simulate ENOENT / rg missing by forcing which() to null.
    const originalWhich = _grepInternals.which
    _grepInternals.which = () => null
    try {
      writeFileSync(join(repoRoot, '.gitignore'), 'secrets.txt\n')
      writeFileSync(join(repoRoot, 'secrets.txt'), 'TOKEN=hunter2')
      writeFileSync(join(repoRoot, 'app.ts'), 'const TOKEN = "hunter2"')

      const tool = getTool('grep_files')!
      const out = await tool.execute({ path: 'r', pattern: 'TOKEN' }, { repoPaths })

      // JS walk output must still match expectations
      expect(out).toContain('app.ts')
      expect(out).toContain(':1: ')
      expect(out).not.toContain('secrets.txt')
    } finally {
      _grepInternals.which = originalWhich
    }
  })

  it('fallback output is identical to grepWithJs direct call', async () => {
    const originalWhich = _grepInternals.which
    _grepInternals.which = () => null
    try {
      writeFileSync(join(repoRoot, 'a.ts'), 'HIT one\nHIT two\n')
      writeFileSync(join(repoRoot, 'b.ts'), 'nothing\nHIT three\n')

      const tool = getTool('grep_files')!
      const out = await tool.execute({ path: 'r', pattern: 'HIT' }, { repoPaths })
      const jsResults = await grepWithJs({ path: 'r', pattern: 'HIT' }, { repoPaths })

      expect(extractMatchKeys(out)).toEqual(extractMatchKeys(jsResults.join('\n')))
    } finally {
      _grepInternals.which = originalWhich
    }
  })

  it('fallback restricts search to a single file when path targets a file', async () => {
    const originalWhich = _grepInternals.which
    _grepInternals.which = () => null
    try {
      writeFileSync(join(repoRoot, 'a.ts'), 'HIT in a\n')
      writeFileSync(join(repoRoot, 'b.ts'), 'HIT in b\n')

      const tool = getTool('grep_files')!
      const out = await tool.execute({ path: 'r/a.ts', pattern: 'HIT' }, { repoPaths })

      expect(out).toContain('a.ts')
      expect(out).not.toContain('b.ts')
    } finally {
      _grepInternals.which = originalWhich
    }
  })

  it('fallback handles globs with multiple wildcards', async () => {
    // Same regression as the rg-backend test, but scoped to the JS path
    // to guarantee the fix survives even when rg is unavailable.
    const originalWhich = _grepInternals.which
    _grepInternals.which = () => null
    try {
      writeFileSync(join(repoRoot, 'foo.test.ts'), 'MULTI hit\n')
      writeFileSync(join(repoRoot, 'bar.test.ts'), 'MULTI hit\n')
      writeFileSync(join(repoRoot, 'plain.ts'), 'MULTI hit\n')

      const tool = getTool('grep_files')!
      const out = await tool.execute(
        { path: 'r', pattern: 'MULTI', glob: '*.test.ts' },
        { repoPaths },
      )

      expect(out).toContain('foo.test.ts')
      expect(out).toContain('bar.test.ts')
      expect(out).not.toContain('plain.ts')
    } finally {
      _grepInternals.which = originalWhich
    }
  })

  it('regex has no g flag — matches across lines are not skipped', async () => {
    // Regression for `new RegExp(pattern, 'g')` + `regex.test(line)` in
    // a loop. Because the RegExp object is stateful under `g`, lastIndex
    // carries between calls. Line 1 below has HIT at offset 10 (lastIndex
    // becomes 13 after the match). Lines 2 and 3 are just "HIT" (length
    // 3): a test() call starting at index 13 finds nothing and returns
    // false, silently dropping those hits. Only after that failed test
    // does lastIndex reset, so line 3 would match again. Net effect on
    // buggy code: 2 hits (lines 1, 3). Correct behaviour: 3 hits.
    //
    // The fixture uses grepWithJs directly so we exercise the JS backend
    // regardless of whether rg is available on the CI runner.
    writeFileSync(
      join(repoRoot, 'file.txt'),
      '0123456789HIT trailing text past position 13\nHIT\nHIT\n',
    )

    const jsResults = await grepWithJs({ path: 'r', pattern: 'HIT' }, { repoPaths })

    expect(jsResults.length).toBe(3)
    expect(jsResults.some((r) => r.startsWith('r/file.txt:1: '))).toBe(true)
    expect(jsResults.some((r) => r.startsWith('r/file.txt:2: '))).toBe(true)
    expect(jsResults.some((r) => r.startsWith('r/file.txt:3: '))).toBe(true)
  })
})
