import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FsGrepTool } from '../FsGrepTool.js'

let baseDir: string

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), 'fs-tools-fsgrep-'))
})

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true })
})

describe('fs_grep', () => {
  it('encuentra coincidencias recursivamente con file/line/text', async () => {
    await mkdir(join(baseDir, 'src'))
    await writeFile(join(baseDir, 'src', 'a.ts'), 'const x = 1;\nfunction foo() {}\n', 'utf-8')
    await writeFile(join(baseDir, 'b.ts'), 'function bar() {}\n', 'utf-8')
    const tool = new FsGrepTool(baseDir)

    const matches = JSON.parse(await tool.handler({ pattern: 'function \\w+\\(' }))

    expect(matches).toEqual(
      expect.arrayContaining([
        { file: join('src', 'a.ts'), line: 2, text: 'function foo() {}' },
        { file: 'b.ts', line: 1, text: 'function bar() {}' },
      ]),
    )
  })

  it('salta node_modules y .git', async () => {
    await mkdir(join(baseDir, 'node_modules'))
    await writeFile(join(baseDir, 'node_modules', 'x.ts'), 'needle', 'utf-8')
    await writeFile(join(baseDir, 'real.ts'), 'needle', 'utf-8')
    const tool = new FsGrepTool(baseDir)

    const matches = JSON.parse(await tool.handler({ pattern: 'needle' }))

    expect(matches).toEqual([{ file: 'real.ts', line: 1, text: 'needle' }])
  })

  it('acota la búsqueda a un subdirectorio dado por path', async () => {
    await mkdir(join(baseDir, 'sub'))
    await writeFile(join(baseDir, 'sub', 'x.ts'), 'needle', 'utf-8')
    await writeFile(join(baseDir, 'outside.ts'), 'needle', 'utf-8')
    const tool = new FsGrepTool(baseDir)

    const matches = JSON.parse(await tool.handler({ pattern: 'needle', path: 'sub' }))

    expect(matches).toEqual([{ file: join('sub', 'x.ts'), line: 1, text: 'needle' }])
  })

  it('busca en un solo archivo cuando path apunta a uno', async () => {
    await mkdir(join(baseDir, 'docs'))
    await writeFile(join(baseDir, 'docs', 'CLAUDE.md'), 'intro\nuv run pytest\nfin\n', 'utf-8')
    await writeFile(join(baseDir, 'other.md'), 'uv run pytest', 'utf-8')
    const tool = new FsGrepTool(baseDir)

    const matches = JSON.parse(
      await tool.handler({ pattern: 'uv run', path: join('docs', 'CLAUDE.md') }),
    )

    expect(matches).toEqual([{ file: join('docs', 'CLAUDE.md'), line: 2, text: 'uv run pytest' }])
  })

  it('salta líneas más largas que el tope — nunca corre el regex contra ellas', async () => {
    const longLine = `${'x'.repeat(3000)}needle`
    await writeFile(join(baseDir, 'a.ts'), `${longLine}\nneedle corto\n`, 'utf-8')
    const tool = new FsGrepTool(baseDir)

    const matches = JSON.parse(await tool.handler({ pattern: 'needle' }))

    expect(matches).toEqual([{ file: 'a.ts', line: 2, text: 'needle corto' }])
  })

  it('salta archivos más grandes que el tope', async () => {
    await writeFile(join(baseDir, 'huge.ts'), `${'x'.repeat(3 * 1024 * 1024)}needle`, 'utf-8')
    await writeFile(join(baseDir, 'small.ts'), 'needle', 'utf-8')
    const tool = new FsGrepTool(baseDir)

    const matches = JSON.parse(await tool.handler({ pattern: 'needle' }))

    expect(matches).toEqual([{ file: 'small.ts', line: 1, text: 'needle' }])
  })

  it('rechaza un pattern vacío', async () => {
    const tool = new FsGrepTool(baseDir)

    await expect(tool.handler({ pattern: '' })).rejects.toThrow(/fs_grep: input inválido/)
  })

  it('salta un FIFO en vez de colgarse esperando un writer', async () => {
    execFileSync('mkfifo', [join(baseDir, 'p')])
    await writeFile(join(baseDir, 'real.ts'), 'needle', 'utf-8')
    const tool = new FsGrepTool(baseDir)

    const matches = JSON.parse(await tool.handler({ pattern: 'needle' }))

    expect(matches).toEqual([{ file: 'real.ts', line: 1, text: 'needle' }])
  }, 10_000)
})
