import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FsEditTool } from '../FsEditTool.js'

let baseDir: string

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), 'fs-tools-fsedit-'))
})

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true })
})

describe('fs_edit', () => {
  it('reemplaza una ocurrencia única', async () => {
    await writeFile(join(baseDir, 'a.ts'), 'const x = 1;\n', 'utf-8')
    const tool = new FsEditTool(baseDir)

    await tool.handler({ path: 'a.ts', oldString: 'const x = 1;', newString: 'const x = 2;' })

    expect(await readFile(join(baseDir, 'a.ts'), 'utf-8')).toBe('const x = 2;\n')
  })

  it('tira si oldString no aparece', async () => {
    await writeFile(join(baseDir, 'a.ts'), 'const x = 1;', 'utf-8')
    const tool = new FsEditTool(baseDir)

    await expect(
      tool.handler({ path: 'a.ts', oldString: 'no existe', newString: 'y' }),
    ).rejects.toThrow('no aparece')
  })

  it('tira si oldString aparece más de una vez sin replaceAll', async () => {
    await writeFile(join(baseDir, 'a.ts'), 'x\nx\n', 'utf-8')
    const tool = new FsEditTool(baseDir)

    await expect(tool.handler({ path: 'a.ts', oldString: 'x', newString: 'y' })).rejects.toThrow(
      'aparece 2 veces',
    )
  })

  it('reemplaza todas las ocurrencias con replaceAll', async () => {
    await writeFile(join(baseDir, 'a.ts'), 'x\nx\n', 'utf-8')
    const tool = new FsEditTool(baseDir)

    await tool.handler({ path: 'a.ts', oldString: 'x', newString: 'y', replaceAll: true })

    expect(await readFile(join(baseDir, 'a.ts'), 'utf-8')).toBe('y\ny\n')
  })

  it('rechaza un path que se escapa de baseDir', async () => {
    const tool = new FsEditTool(baseDir)
    await expect(
      tool.handler({ path: '../evil.ts', oldString: 'a', newString: 'b' }),
    ).rejects.toThrow('fuera de baseDir')
  })

  it('rechaza el input sin newString y no toca el archivo', async () => {
    await writeFile(join(baseDir, 'a.ts'), 'const x = 1;\n', 'utf-8')
    const tool = new FsEditTool(baseDir)

    await expect(tool.handler({ path: 'a.ts', oldString: 'const x = 1;' })).rejects.toThrow(
      /fs_edit: input inválido[\s\S]*→ at newString/,
    )
    expect(await readFile(join(baseDir, 'a.ts'), 'utf-8')).toBe('const x = 1;\n')
  })

  it('rechaza un oldString vacío', async () => {
    await writeFile(join(baseDir, 'a.ts'), 'x', 'utf-8')
    const tool = new FsEditTool(baseDir)

    await expect(tool.handler({ path: 'a.ts', oldString: '', newString: 'y' })).rejects.toThrow(
      /input inválido[\s\S]*→ at oldString/,
    )
  })

  it('rechaza un FIFO en vez de colgarse esperando un writer', async () => {
    const fifoPath = join(baseDir, 'p')
    execFileSync('mkfifo', [fifoPath])
    const tool = new FsEditTool(baseDir)

    await expect(tool.handler({ path: 'p', oldString: 'x', newString: 'y' })).rejects.toThrow(
      'no es un archivo regular',
    )
  })
})
