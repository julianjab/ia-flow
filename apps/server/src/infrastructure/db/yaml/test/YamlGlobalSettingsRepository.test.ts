import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { YamlGlobalSettingsRepository } from '../YamlGlobalSettingsRepository.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yaml-global-settings-repo-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeFile(yaml: string): string {
  const filePath = join(dir, 'settings.yaml')
  writeFileSync(filePath, yaml)
  return filePath
}

describe('YamlGlobalSettingsRepository', () => {
  it('carga un objeto plano de values + scanRoots', () => {
    const filePath = writeFile(`
scanRoots:
  - /repos/one
  - /repos/two
values:
  someKey: someValue
`)
    const repo = new YamlGlobalSettingsRepository(filePath)

    expect(repo.getAll()).toEqual({ someKey: 'someValue' })
    expect(repo.get('someKey')).toBe('someValue')
    expect(repo.get('missing')).toBeNull()
    expect(repo.getScanRoots()).toEqual(['/repos/one', '/repos/two'])
  })

  it('acepta un YAML vacío — todo cae a los defaults', () => {
    const filePath = writeFile('')
    const repo = new YamlGlobalSettingsRepository(filePath)

    expect(repo.getAll()).toEqual({})
    expect(repo.getScanRoots()).toEqual([])
  })

  it('tira error legible si el archivo no existe', () => {
    expect(() => new YamlGlobalSettingsRepository(join(dir, 'missing.yaml'))).toThrow(
      /no se pudo leer/,
    )
  })

  it('tira error legible si el YAML no matchea el schema', () => {
    const filePath = writeFile(`
scanRoots: 'not-an-array'
`)
    expect(() => new YamlGlobalSettingsRepository(filePath)).toThrow(/YamlGlobalSettingsSchema/)
  })

  it('los métodos de escritura tiran — el repo es read-only', () => {
    const filePath = writeFile(`
values:
  key: value
`)
    const repo = new YamlGlobalSettingsRepository(filePath)

    expect(() => repo.set('key', 'value2')).toThrow(/solo lectura/)
    expect(() => repo.setMany({ key: 'value2' })).toThrow(/solo lectura/)
    expect(() => repo.delete('key')).toThrow(/solo lectura/)
    expect(() => repo.setScanRoots(['/x'])).toThrow(/solo lectura/)
  })
})
