import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FsToolRegistry } from '../FsToolRegistry.js'

let baseDir: string

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), 'fs-tools-registry-'))
})

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true })
})

describe('FsToolRegistry', () => {
  it('names() lista las 5 tools', () => {
    expect(new FsToolRegistry(baseDir).names()).toEqual([
      'fs_read',
      'fs_list',
      'fs_grep',
      'fs_write',
      'fs_edit',
    ])
  })

  it('all() devuelve las mismas tools que names()', () => {
    const registry = new FsToolRegistry(baseDir)
    expect(registry.all().map((tool) => tool.name)).toEqual(registry.names())
  })

  it('get(name) resuelve una tool por nombre', () => {
    const tool = new FsToolRegistry(baseDir).get('fs_write')
    expect(tool.name).toBe('fs_write')
  })

  it('get(name) tira con mensaje útil para un nombre desconocido', () => {
    const registry = new FsToolRegistry(baseDir)
    expect(() => registry.get('fs_delete')).toThrow('fs_delete')
    expect(() => registry.get('fs_delete')).toThrow('fs_read')
  })

  it('resolve(names) mapea una lista de nombres a sus Tools, en orden', () => {
    const resolved = new FsToolRegistry(baseDir).resolve(['fs_grep', 'fs_read'])
    expect(resolved.map((tool) => tool.name)).toEqual(['fs_grep', 'fs_read'])
  })

  it('resolve(names) tira en el primer nombre desconocido', () => {
    const registry = new FsToolRegistry(baseDir)
    expect(() => registry.resolve(['fs_read', 'nope'])).toThrow('nope')
  })
})
