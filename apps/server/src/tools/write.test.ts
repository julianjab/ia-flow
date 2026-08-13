import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ToolContext, getTool } from './index.js'
import './write.js' // side-effect: register write_file / edit_file

// Three isolated tmp roots per test:
//   - repoRoot   → registered as `r`; represents a repo that IS in repoPaths
//                  but NOT in writePaths (regression case for the sandbox).
//   - writeRoot  → registered as `w`; the only allowed writable root.
//   - outsideRoot→ registered as `o`; another repo path used to confirm that
//                  membership in repoPaths alone doesn't grant write access.
let repoRoot: string
let writeRoot: string
let outsideRoot: string
let ctxBase: Omit<ToolContext, 'writePaths'>

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'ia-flow-write-repo-'))
  writeRoot = mkdtempSync(join(tmpdir(), 'ia-flow-write-scope-'))
  outsideRoot = mkdtempSync(join(tmpdir(), 'ia-flow-write-outside-'))
  ctxBase = { repoPaths: { r: repoRoot, w: writeRoot, o: outsideRoot } }
})

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
  rmSync(writeRoot, { recursive: true, force: true })
  rmSync(outsideRoot, { recursive: true, force: true })
})

function ctxWith(writePaths?: string[]): ToolContext {
  return { ...ctxBase, writePaths }
}

describe('write_file — happy paths', () => {
  it('creates a new file with the provided content', async () => {
    const tool = getTool('write_file')!
    const out = await tool.execute(
      { path: 'w/new.txt', content: 'hello world' },
      ctxWith([writeRoot]),
    )
    expect(out).toContain('Archivo escrito')
    expect(readFileSync(join(writeRoot, 'new.txt'), 'utf-8')).toBe('hello world')
  })

  it('overwrites an existing file in-place', async () => {
    writeFileSync(join(writeRoot, 'existing.txt'), 'old contents')
    const tool = getTool('write_file')!
    await tool.execute(
      { path: 'w/existing.txt', content: 'new contents' },
      ctxWith([writeRoot]),
    )
    expect(readFileSync(join(writeRoot, 'existing.txt'), 'utf-8')).toBe('new contents')
  })

  it('creates missing parent directories (mkdir -p)', async () => {
    const tool = getTool('write_file')!
    await tool.execute(
      { path: 'w/nested/deep/file.md', content: '# hi' },
      ctxWith([writeRoot]),
    )
    expect(readFileSync(join(writeRoot, 'nested/deep/file.md'), 'utf-8')).toBe('# hi')
  })
})

describe('write_file — writePaths validation', () => {
  it('rejects paths outside writePaths with the sandbox message', async () => {
    const tool = getTool('write_file')!
    await expect(
      tool.execute({ path: 'o/leak.txt', content: 'nope' }, ctxWith([writeRoot])),
    ).rejects.toThrow('escritura no permitida en fase actual')
  })

  it('rejects paths that live in repoPaths but not in writePaths', async () => {
    // `r` is a known repo (present in repoPaths) but not part of writePaths.
    // The write must be refused just like any unrelated absolute path — being
    // "readable" (in repoPaths) doesn't imply "writable".
    const tool = getTool('write_file')!
    await expect(
      tool.execute(
        { path: 'r/inside-repo.txt', content: 'nope' },
        ctxWith([writeRoot]),
      ),
    ).rejects.toThrow('escritura no permitida en fase actual')
  })

  it('fails explicitly when writePaths is an empty array', async () => {
    const tool = getTool('write_file')!
    await expect(
      tool.execute({ path: 'w/foo.txt', content: 'x' }, ctxWith([])),
    ).rejects.toThrow('writePaths vacío')
  })

  it('fails explicitly when writePaths is undefined', async () => {
    const tool = getTool('write_file')!
    await expect(
      tool.execute({ path: 'w/foo.txt', content: 'x' }, ctxWith(undefined)),
    ).rejects.toThrow('writePaths vacío')
  })
})

describe('edit_file — happy paths', () => {
  it('replaces a unique occurrence of old_string', async () => {
    writeFileSync(join(writeRoot, 'a.ts'), 'const answer = 41\n')
    const tool = getTool('edit_file')!
    const out = await tool.execute(
      { path: 'w/a.ts', old_string: '41', new_string: '42' },
      ctxWith([writeRoot]),
    )
    expect(out).toContain('Edición aplicada')
    expect(readFileSync(join(writeRoot, 'a.ts'), 'utf-8')).toBe('const answer = 42\n')
  })

  it('replaces every occurrence when replace_all=true', async () => {
    writeFileSync(join(writeRoot, 'a.ts'), 'foo\nfoo\nfoo\n')
    const tool = getTool('edit_file')!
    const out = await tool.execute(
      {
        path: 'w/a.ts',
        old_string: 'foo',
        new_string: 'bar',
        replace_all: true,
      },
      ctxWith([writeRoot]),
    )
    expect(out).toContain('Edición aplicada')
    expect(readFileSync(join(writeRoot, 'a.ts'), 'utf-8')).toBe('bar\nbar\nbar\n')
  })
})

describe('edit_file — validation failures', () => {
  it('fails with a clear message when old_string is absent', async () => {
    writeFileSync(join(writeRoot, 'a.ts'), 'const x = 1\n')
    const tool = getTool('edit_file')!
    await expect(
      tool.execute(
        { path: 'w/a.ts', old_string: 'MISSING', new_string: 'X' },
        ctxWith([writeRoot]),
      ),
    ).rejects.toThrow('old_string no encontrado en w/a.ts')
  })

  it('fails with the occurrence count when ambiguous and replace_all=false', async () => {
    writeFileSync(join(writeRoot, 'a.ts'), 'foo\nfoo\nfoo\n')
    const tool = getTool('edit_file')!
    await expect(
      tool.execute(
        { path: 'w/a.ts', old_string: 'foo', new_string: 'bar' },
        ctxWith([writeRoot]),
      ),
    ).rejects.toThrow('aparece 3 veces en w/a.ts')
  })

  it('rejects edits on files outside writePaths', async () => {
    writeFileSync(join(outsideRoot, 'a.ts'), 'foo')
    const tool = getTool('edit_file')!
    await expect(
      tool.execute(
        { path: 'o/a.ts', old_string: 'foo', new_string: 'bar' },
        ctxWith([writeRoot]),
      ),
    ).rejects.toThrow('escritura no permitida en fase actual')
  })

  it('rejects edits when writePaths is empty', async () => {
    // Even a real, existing file under repoPaths must be refused if
    // writePaths is empty — the guard fires before we ever touch disk.
    writeFileSync(join(writeRoot, 'a.ts'), 'foo')
    const tool = getTool('edit_file')!
    await expect(
      tool.execute(
        { path: 'w/a.ts', old_string: 'foo', new_string: 'bar' },
        ctxWith([]),
      ),
    ).rejects.toThrow('writePaths vacío')
  })
})

describe('write/edit — registration metadata', () => {
  it('write_file is registered with apiOnly: true', () => {
    const tool = getTool('write_file')!
    expect(tool).toBeDefined()
    expect(tool.apiOnly).toBe(true)
  })

  it('edit_file is registered with apiOnly: true', () => {
    const tool = getTool('edit_file')!
    expect(tool).toBeDefined()
    expect(tool.apiOnly).toBe(true)
  })
})
