import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as lib from '../index.js'

let baseDir: string

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), 'fs-tools-index-'))
})

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true })
})

describe('package entrypoint', () => {
  it('exporta la API pública', () => {
    expect(lib.FsTool).toBeDefined()
    expect(lib.FsToolRegistry).toBeDefined()
    expect(lib.resolveSafePath).toBeTypeOf('function')
    expect(lib.FsReadTool).toBeDefined()
    expect(lib.FsListTool).toBeDefined()
    expect(lib.FsGrepTool).toBeDefined()
    expect(lib.FsWriteTool).toBeDefined()
    expect(lib.FsEditTool).toBeDefined()
  })

  it('una tool concreta anda sola, sin pasar por el registry', async () => {
    const tool = new lib.FsWriteTool(baseDir)
    const result = await tool.handler({ path: 'a.txt', content: 'x' })
    expect(result).toContain('a.txt')
  })

  it('el registry expone las mismas tools que las clases sueltas', () => {
    const registry = new lib.FsToolRegistry(baseDir)
    expect(registry.get('fs_read').name).toBe(new lib.FsReadTool(baseDir).name)
  })
})
