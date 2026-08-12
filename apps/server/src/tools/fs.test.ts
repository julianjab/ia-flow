import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _grepInternals, grepWithJs } from './fs.js'
import { _clearGitignoreCache } from './gitignore.js'
import { getTool } from './index.js'
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
    writeFileSync(
      join(repoRoot, 'a.ts'),
      'const NEEDLE = 1\nfoo\nsecond NEEDLE hit\nmore',
    )
    mkdirSync(join(repoRoot, 'sub'))
    writeFileSync(join(repoRoot, 'sub/b.ts'), 'first line\nNEEDLE at sub\n')
    writeFileSync(join(repoRoot, 'ignored.log'), 'NEEDLE in ignored\n')
    mkdirSync(join(repoRoot, 'node_modules'))
    writeFileSync(join(repoRoot, 'node_modules/dep.js'), 'NEEDLE in dep\n')

    const tool = getTool('grep_files')!
    const backendOut = await tool.execute(
      { path: 'r', pattern: 'NEEDLE' },
      { repoPaths },
    )
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
})
