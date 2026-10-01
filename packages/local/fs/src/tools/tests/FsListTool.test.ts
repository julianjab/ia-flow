import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FsListTool } from '../FsListTool.js'

let baseDir: string

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), 'fs-tools-fslist-'))
})

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true })
})

describe('fs_list', () => {
  it('lista archivos y carpetas, ordenados por nombre', async () => {
    await writeFile(join(baseDir, 'b.txt'), '', 'utf-8')
    await mkdir(join(baseDir, 'a-dir'))
    await writeFile(join(baseDir, 'c.txt'), '', 'utf-8')
    const tool = new FsListTool(baseDir)

    expect(JSON.parse(await tool.handler({}))).toEqual([
      { name: 'a-dir', type: 'dir' },
      { name: 'b.txt', type: 'file' },
      { name: 'c.txt', type: 'file' },
    ])
  })

  it('lista un subdirectorio dado por path', async () => {
    await mkdir(join(baseDir, 'sub'))
    await writeFile(join(baseDir, 'sub', 'x.txt'), '', 'utf-8')
    const tool = new FsListTool(baseDir)

    expect(JSON.parse(await tool.handler({ path: 'sub' }))).toEqual([
      { name: 'x.txt', type: 'file' },
    ])
  })

  it('rechaza un path que se escapa de baseDir', async () => {
    const tool = new FsListTool(baseDir)
    await expect(tool.handler({ path: '..' })).rejects.toThrow('fuera de baseDir')
  })

  it('rechaza un path que no es string', async () => {
    const tool = new FsListTool(baseDir)

    await expect(tool.handler({ path: 1 })).rejects.toThrow(/fs_list: input inválido/)
  })
})
