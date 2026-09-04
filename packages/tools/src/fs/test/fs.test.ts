import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getTool } from '../../engine.js'
import { _grepInternals, globWithJs, globWithRg, grepWithJs, grepWithRg } from '../fs.js'
import { _clearGitignoreCache } from '../gitignore.js'
import '../fs.js' // side-effect: register list_dir / grep_files

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

describe('fs_read — focus', () => {
  const originalFetch = globalThis.fetch
  const originalKey = Bun.env.ANTHROPIC_API_KEY
  const originalSwitch = Bun.env.IA_FLOW_FILE_SIMPLIFIER
  let calls: Array<{ body: any }>

  const big = Array.from({ length: 1200 }, (_, i) => `line ${i + 1}: ${'x'.repeat(30)}`).join('\n')

  beforeEach(() => {
    calls = []
    Bun.env.ANTHROPIC_API_KEY = 'test-key'
    delete Bun.env.IA_FLOW_FILE_SIMPLIFIER
    globalThis.fetch = (async (_url: any, init: any) => {
      const body = JSON.parse(init.body)
      calls.push({ body })
      return new Response(
        JSON.stringify({ content: [{ type: 'text', text: '## lines 3-4\nextracted' }], usage: {} }),
        { status: 200 },
      )
    }) as any
    writeFileSync(join(repoRoot, 'big.txt'), big)
    writeFileSync(join(repoRoot, 'small.txt'), 'hello\nworld')
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalKey === undefined) delete Bun.env.ANTHROPIC_API_KEY
    else Bun.env.ANTHROPIC_API_KEY = originalKey
    if (originalSwitch === undefined) delete Bun.env.IA_FLOW_FILE_SIMPLIFIER
    else Bun.env.IA_FLOW_FILE_SIMPLIFIER = originalSwitch
  })

  const read = (input: Record<string, unknown>, ctx: Record<string, unknown> = {}) =>
    getTool('fs_read')!.execute(input, { repoPaths, ...ctx } as any)

  it('returns a small file whole, focus or not', async () => {
    expect(await read({ path: 'r/small.txt' })).toBe('hello\nworld')
    expect(await read({ path: 'r/small.txt', focus: 'anything' })).toBe('hello\nworld')
    expect(calls).toHaveLength(0)
  })

  it('without focus cuts a large file at the cap and says how to page', async () => {
    const out = await read({ path: 'r/big.txt' })
    expect(calls).toHaveLength(0)
    expect(out.startsWith('line 1:')).toBe(true)
    expect(out).toContain(`${big.length} bytes, 1200 lines`)
    expect(out).toContain('Use offset/limit to page, or pass focus')
    expect(out.length).toBeLessThan(big.length)
  })

  it('with focus asks Haiku with the need and numbered lines', async () => {
    const out = await read({ path: 'r/big.txt', focus: 'the third line' })
    expect(calls).toHaveLength(1)
    const user = calls[0]!.body.messages[0].content as string
    expect(calls[0]!.body.model).toBe('claude-haiku-4-5-20251001')
    expect(user).toContain('File: r/big.txt')
    expect(user).toContain('Reader needs: the third line')
    expect(user).toContain('\n3\tline 3:')
    expect(out).toBe(`[focus: the third line — ${big.length}B → 22B]\n## lines 3-4\nextracted`)
  })

  it('IA_FLOW_FILE_SIMPLIFIER=0 ignores focus and returns the head', async () => {
    Bun.env.IA_FLOW_FILE_SIMPLIFIER = '0'
    const out = await read({ path: 'r/big.txt', focus: 'the third line' })
    expect(calls).toHaveLength(0)
    expect(out).toContain('(focus disabled)')
  })

  it('per-agent override wins over the env switch', async () => {
    Bun.env.IA_FLOW_FILE_SIMPLIFIER = '0'
    await read({ path: 'r/big.txt', focus: 'x' }, { fileSimplifierEnabled: true })
    expect(calls).toHaveLength(1)
  })

  it('falls back to the head when Haiku fails or there is no auth', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 500 })) as any
    let out = await read({ path: 'r/big.txt', focus: 'x' })
    expect(out).toContain('(focus unavailable)')

    delete Bun.env.ANTHROPIC_API_KEY
    out = await read({ path: 'r/big.txt', focus: 'x' })
    expect(out).toContain('(focus unavailable)')
  })
})

describe('fs_list — dotfiles and recursion', () => {
  it('shows dotfiles/dot-directories, excluding only the hard list', async () => {
    mkdirSync(join(repoRoot, '.github'))
    writeFileSync(join(repoRoot, '.github/workflow.yml'), 'x')
    writeFileSync(join(repoRoot, '.env.example'), 'x')
    mkdirSync(join(repoRoot, 'node_modules'))
    writeFileSync(join(repoRoot, 'node_modules/dep.js'), 'x')

    const tool = getTool('fs_list')!
    const out = await tool.execute({ path: 'r' }, { repoPaths })

    expect(out).toContain('d .github')
    expect(out).toContain('f .env.example')
    expect(out).not.toContain('node_modules')
  })
})

describe('fs_list — depth', () => {
  it('depth 1 (default) only lists the top level', async () => {
    mkdirSync(join(repoRoot, 'sub'))
    writeFileSync(join(repoRoot, 'sub/nested.ts'), 'x')
    writeFileSync(join(repoRoot, 'top.ts'), 'x')

    const tool = getTool('fs_list')!
    const out = await tool.execute({ path: 'r' }, { repoPaths })

    expect(out).toContain('f top.ts')
    expect(out).toContain('d sub')
    expect(out).not.toContain('nested.ts')
  })

  it('depth: 3 recurses and includes nested paths', async () => {
    mkdirSync(join(repoRoot, 'a/b'), { recursive: true })
    writeFileSync(join(repoRoot, 'a/one.ts'), 'x')
    writeFileSync(join(repoRoot, 'a/b/two.ts'), 'x')

    const tool = getTool('fs_list')!
    const out = await tool.execute({ path: 'r', depth: 3 }, { repoPaths })

    expect(out).toContain('d a')
    expect(out).toContain('f a/one.ts')
    expect(out).toContain('d a/b')
    expect(out).toContain('f a/b/two.ts')
  })

  it('still honors .gitignore while recursing', async () => {
    writeFileSync(join(repoRoot, '.gitignore'), 'a/ignored.ts\n')
    mkdirSync(join(repoRoot, 'a'))
    writeFileSync(join(repoRoot, 'a/ignored.ts'), 'x')
    writeFileSync(join(repoRoot, 'a/kept.ts'), 'x')

    const tool = getTool('fs_list')!
    const out = await tool.execute({ path: 'r', depth: 2 }, { repoPaths })

    expect(out).toContain('a/kept.ts')
    expect(out).not.toContain('ignored.ts')
  })

  it('caps the entry count instead of dumping an unbounded tree', async () => {
    for (let i = 0; i < 50; i++) {
      mkdirSync(join(repoRoot, `dir${i}`))
      for (let j = 0; j < 60; j++) {
        writeFileSync(join(repoRoot, `dir${i}/f${j}.ts`), 'x')
      }
    }

    const tool = getTool('fs_list')!
    const out = await tool.execute({ path: 'r', depth: 5 }, { repoPaths })

    const entryCount = out
      .split('\n')
      .filter((l) => l.startsWith('d ') || l.startsWith('f ')).length
    expect(entryCount).toBeLessThanOrEqual(2000)
    expect(out).toContain('Truncated at 2000 entries')
  })

  it('caps `depth` regardless of what the model asks for', async () => {
    mkdirSync(join(repoRoot, 'a'))
    writeFileSync(join(repoRoot, 'a/one.ts'), 'x')

    const tool = getTool('fs_list')!
    // depth: 999 must not blow the stack / hang — it's clamped internally.
    const out = await tool.execute({ path: 'r', depth: 999 }, { repoPaths })
    expect(out).toContain('a/one.ts')
  })

  it('falls back to depth 1 when `depth` is not a valid number', async () => {
    mkdirSync(join(repoRoot, 'sub'))
    writeFileSync(join(repoRoot, 'sub/nested.ts'), 'x')
    writeFileSync(join(repoRoot, 'top.ts'), 'x')

    const tool = getTool('fs_list')!
    const out = await tool.execute({ path: 'r', depth: 'not-a-number' }, { repoPaths })
    expect(out).toContain('f top.ts')
    expect(out).not.toContain('nested.ts')
  })
})

describe('fs_grep — pagination and total', () => {
  it('reports the total and a cursor when there are more matches than the page size', async () => {
    for (let i = 0; i < 120; i++) {
      writeFileSync(join(repoRoot, `f${i}.ts`), 'PAGED hit\n')
    }

    const tool = getTool('fs_grep')!
    const first = await tool.execute({ path: 'r', pattern: 'PAGED' }, { repoPaths })
    expect(first).toContain('of 120')
    expect(first).toContain('Pass cursor: "100"')

    const cursorMatch = /cursor: "(\d+)"/.exec(first)
    expect(cursorMatch).not.toBeNull()
    const second = await tool.execute(
      { path: 'r', pattern: 'PAGED', cursor: cursorMatch![1] },
      { repoPaths },
    )
    expect(second).toContain('101-120 of 120')
  })

  it('does not print pagination header when everything fits on one page', async () => {
    writeFileSync(join(repoRoot, 'a.ts'), 'ONE hit\n')

    const tool = getTool('fs_grep')!
    const out = await tool.execute({ path: 'r', pattern: 'ONE' }, { repoPaths })
    expect(out).not.toContain('Showing')
  })
})

describe('fs_grep — context_lines (rg ↔ JS parity)', () => {
  it('returns the lines around each match, both backends agree', async () => {
    writeFileSync(join(repoRoot, 'a.ts'), ['one', 'two', 'HIT here', 'four', 'five'].join('\n'))

    const tool = getTool('fs_grep')!
    const backendOut = await tool.execute(
      { path: 'r', pattern: 'HIT', context_lines: 1 },
      { repoPaths },
    )
    const jsOut = (
      await grepWithJs({ path: 'r', pattern: 'HIT', context_lines: 1 }, { repoPaths })
    ).join('\n')

    expect(backendOut).toContain('two')
    expect(backendOut).toContain('HIT here')
    expect(backendOut).toContain('four')

    const rgOut = await grepWithRg({ path: 'r', pattern: 'HIT', context_lines: 1 }, { repoPaths })
    if (rgOut !== null) {
      expect(rgOut.join('\n')).toBe(jsOut)
    }
  })

  it('does not lose the match when the path itself contains "-<digits>-" (regression)', async () => {
    // Regresión: parsear el output de texto plano de rg con un regex
    // `^(.*?)([:-])(\d+)\2(.*)$` clasifica mal un match cuyo path contenga
    // un patrón "-<dígitos>-" (ej. `step-2-form.vue`) como línea de
    // contexto en vez de match, y el match desaparece del resultado. El
    // backend rg ahora parsea `--json`, que no tiene esta ambigüedad.
    mkdirSync(join(repoRoot, 'sub'))
    writeFileSync(join(repoRoot, 'sub/step-2-form.vue'), 'const HIT = 1\n')

    const tool = getTool('fs_grep')!
    const out = await tool.execute({ path: 'r', pattern: 'HIT' }, { repoPaths })
    expect(out).toContain('step-2-form.vue')
    expect(out).toContain(': const HIT = 1')

    const rgOut = await grepWithRg({ path: 'r', pattern: 'HIT' }, { repoPaths })
    if (rgOut !== null) {
      expect(rgOut.some((r) => r.includes('step-2-form.vue'))).toBe(true)
    }
  })
})

describe('fs_grep — files_only (rg ↔ JS parity)', () => {
  it('lists only the matching files, no line content', async () => {
    writeFileSync(join(repoRoot, 'a.ts'), 'ONLY hit\nsecond ONLY hit\n')
    writeFileSync(join(repoRoot, 'b.ts'), 'nothing here\n')
    writeFileSync(join(repoRoot, 'c.ts'), 'ONLY once\n')

    const tool = getTool('fs_grep')!
    const backendOut = await tool.execute(
      { path: 'r', pattern: 'ONLY', files_only: true },
      { repoPaths },
    )
    const jsResults = await grepWithJs(
      { path: 'r', pattern: 'ONLY', files_only: true },
      { repoPaths },
    )

    expect(backendOut).toContain('a.ts')
    expect(backendOut).toContain('c.ts')
    expect(backendOut).not.toContain('b.ts')
    expect(backendOut).not.toContain(': ONLY')
    expect(jsResults.sort()).toEqual(jsResults.slice().sort())

    const rgResults = await grepWithRg(
      { path: 'r', pattern: 'ONLY', files_only: true },
      { repoPaths },
    )
    if (rgResults !== null) {
      expect(rgResults.sort()).toEqual(jsResults.sort())
    }
  })
})

describe('fs_grep — dotfiles (rg ↔ JS parity)', () => {
  it('searches inside dot-directories, not just visible ones', async () => {
    mkdirSync(join(repoRoot, '.github'))
    writeFileSync(join(repoRoot, '.github/workflow.yml'), 'NEEDLE in ci config\n')

    const tool = getTool('fs_grep')!
    const out = await tool.execute({ path: 'r', pattern: 'NEEDLE' }, { repoPaths })
    expect(out).toContain('.github/workflow.yml')

    const rgResults = await grepWithRg({ path: 'r', pattern: 'NEEDLE' }, { repoPaths })
    if (rgResults !== null) {
      expect(rgResults.some((r) => r.includes('.github/workflow.yml'))).toBe(true)
    }
  })
})

describe('fs_grep — cursor past the end', () => {
  it('reports there are no more matches instead of an empty page', async () => {
    writeFileSync(join(repoRoot, 'a.ts'), 'ONE hit\n')

    const tool = getTool('fs_grep')!
    const out = await tool.execute({ path: 'r', pattern: 'ONE', cursor: '999' }, { repoPaths })
    expect(out).toContain('No more matches')
  })

  it('accepts a numeric cursor, not just a stringified one', async () => {
    for (let i = 0; i < 110; i++) {
      writeFileSync(join(repoRoot, `f${i}.ts`), 'NUMCUR hit\n')
    }

    const tool = getTool('fs_grep')!
    const out = await tool.execute({ path: 'r', pattern: 'NUMCUR', cursor: 100 }, { repoPaths })
    expect(out).toContain('101-110 of 110')
  })
})

describe('fs_grep — pagination is stable across calls (rg backend)', () => {
  it('two pages together cover every match exactly once, in the same order both times', async () => {
    for (let i = 0; i < 150; i++) {
      writeFileSync(join(repoRoot, `s${i}.ts`), 'STABLE hit\n')
    }

    const firstPass = await grepWithRg({ path: 'r', pattern: 'STABLE' }, { repoPaths })
    const secondPass = await grepWithRg({ path: 'r', pattern: 'STABLE' }, { repoPaths })
    if (firstPass !== null && secondPass !== null) {
      expect(firstPass).toEqual(secondPass)
    }
  })
})

describe('fs_grep — invalid pattern does not crash the tool', () => {
  it('falls back to an error message instead of throwing when JS regex parsing fails', async () => {
    writeFileSync(join(repoRoot, 'a.ts'), 'x')
    const originalWhich = _grepInternals.which
    _grepInternals.which = () => null // force the JS fallback
    try {
      const tool = getTool('fs_grep')!
      // `(?P<name>...)` is valid in rg's regex engine but not in JS RegExp.
      const out = await tool.execute({ path: 'r', pattern: '(?P<name>x)' }, { repoPaths })
      expect(out).toContain('Invalid pattern')
    } finally {
      _grepInternals.which = originalWhich
    }
  })
})

describe('fs_glob — cap inside a single large directory', () => {
  it('stops accumulating within one directory instead of matching everything before slicing', async () => {
    mkdirSync(join(repoRoot, 'big'))
    for (let i = 0; i < 2100; i++) {
      writeFileSync(join(repoRoot, `big/f${i}.ts`), 'x')
    }

    const results = await globWithJs({ path: 'r', pattern: '**/*.ts' }, { repoPaths })
    expect(results.length).toBeLessThanOrEqual(200)
  })
})

describe('fs_glob', () => {
  it('finds files matching a recursive glob (rg ↔ JS parity)', async () => {
    mkdirSync(join(repoRoot, 'apps/server'), { recursive: true })
    writeFileSync(join(repoRoot, 'apps/server/foo.test.ts'), 'x')
    writeFileSync(join(repoRoot, 'apps/server/foo.ts'), 'x')
    writeFileSync(join(repoRoot, 'root.test.ts'), 'x')
    writeFileSync(join(repoRoot, 'notes.md'), 'x')

    const tool = getTool('fs_glob')!
    const out = await tool.execute({ path: 'r', pattern: '**/*.test.ts' }, { repoPaths })

    expect(out).toContain('apps/server/foo.test.ts')
    expect(out).toContain('root.test.ts')
    expect(out).not.toContain('foo.ts\n')
    expect(out).not.toContain('notes.md')

    const jsResults = await globWithJs({ path: 'r', pattern: '**/*.test.ts' }, { repoPaths })
    const rgResults = await globWithRg({ path: 'r', pattern: '**/*.test.ts' }, { repoPaths })
    if (rgResults !== null) {
      expect([...rgResults].sort()).toEqual([...jsResults].sort())
    }
  })

  it('returns a not-found message when nothing matches', async () => {
    writeFileSync(join(repoRoot, 'a.ts'), 'x')

    const tool = getTool('fs_glob')!
    const out = await tool.execute({ path: 'r', pattern: '**/*.nonexistent' }, { repoPaths })
    expect(out).toContain('No files matching')
  })

  it('finds files inside dot-directories (rg ↔ JS parity)', async () => {
    mkdirSync(join(repoRoot, '.github/workflows'), { recursive: true })
    writeFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'x')

    const tool = getTool('fs_glob')!
    const out = await tool.execute({ path: 'r', pattern: '**/*.yml' }, { repoPaths })
    expect(out).toContain('.github/workflows/ci.yml')

    const rgResults = await globWithRg({ path: 'r', pattern: '**/*.yml' }, { repoPaths })
    if (rgResults !== null) {
      expect(rgResults.some((r) => r.includes('.github/workflows/ci.yml'))).toBe(true)
    }
  })

  it('scopes the glob to the given subdirectory', async () => {
    mkdirSync(join(repoRoot, 'a'))
    mkdirSync(join(repoRoot, 'b'))
    writeFileSync(join(repoRoot, 'a/hit.test.ts'), 'x')
    writeFileSync(join(repoRoot, 'b/hit.test.ts'), 'x')

    const tool = getTool('fs_glob')!
    const out = await tool.execute({ path: 'r/a', pattern: '*.test.ts' }, { repoPaths })

    expect(out).toContain('a/hit.test.ts')
    expect(out).not.toContain('b/hit.test.ts')
  })

  it('a slash-less pattern matches the basename at any depth (rg ↔ JS parity)', async () => {
    // Regresión: `*.ts` (sin "/") tiene que encontrar archivos a cualquier
    // profundidad, como hace `rg --glob` — no sólo los del nivel raíz.
    mkdirSync(join(repoRoot, 'deep/er'), { recursive: true })
    writeFileSync(join(repoRoot, 'root.ts'), 'x')
    writeFileSync(join(repoRoot, 'deep/mid.ts'), 'x')
    writeFileSync(join(repoRoot, 'deep/er/leaf.ts'), 'x')
    writeFileSync(join(repoRoot, 'deep/er/leaf.md'), 'x')

    const tool = getTool('fs_glob')!
    const out = await tool.execute({ path: 'r', pattern: '*.ts' }, { repoPaths })

    expect(out).toContain('root.ts')
    expect(out).toContain('deep/mid.ts')
    expect(out).toContain('deep/er/leaf.ts')
    expect(out).not.toContain('leaf.md')

    const jsResults = await globWithJs({ path: 'r', pattern: '*.ts' }, { repoPaths })
    const rgResults = await globWithRg({ path: 'r', pattern: '*.ts' }, { repoPaths })
    if (rgResults !== null) {
      expect([...rgResults].sort()).toEqual([...jsResults].sort())
    }
  })
})
