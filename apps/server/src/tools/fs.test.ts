import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
