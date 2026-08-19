import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { YamlSystemPromptRepository } from '../YamlSystemPromptRepository.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yaml-system-prompt-repo-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeFile(yaml: string): string {
  const filePath = join(dir, 'system-prompts.yaml')
  writeFileSync(filePath, yaml)
  return filePath
}

describe('YamlSystemPromptRepository', () => {
  it('carga prompts globales y por proyecto desde YAML', () => {
    const filePath = writeFile(`
- id: global-sp
  name: Global
  text: prompt global
- id: scoped-sp
  name: Scoped
  text: solo para p1
  projectId: p1
`)
    const repo = new YamlSystemPromptRepository(filePath)

    expect(repo.inScope(undefined).map((sp) => sp.id)).toEqual(['global-sp', 'scoped-sp'])
    expect(repo.inScope(null).map((sp) => sp.id)).toEqual(['global-sp'])
    expect(repo.inScope('p1').map((sp) => sp.id)).toEqual(['scoped-sp'])
  })

  it('getById devuelve el prompt o null', () => {
    const filePath = writeFile(`
- id: only-sp
  name: Only
  text: unico
`)
    const repo = new YamlSystemPromptRepository(filePath)

    expect(repo.getById('only-sp')?.text).toBe('unico')
    expect(repo.getById('missing')).toBeNull()
  })

  it('visibleTo devuelve globales + los de ese proyecto, con shadow del scoped', () => {
    const filePath = writeFile(`
- id: dup
  name: Global dup
  text: global
- id: dup
  name: Scoped dup
  text: override de p1
  projectId: p1
- id: other-project
  name: Otro
  text: no debe aparecer
  projectId: p2
`)
    const repo = new YamlSystemPromptRepository(filePath)
    const visible = repo.visibleTo('p1')

    expect(visible.map((sp) => sp.id).sort()).toEqual(['dup'])
    expect(visible.find((sp) => sp.id === 'dup')?.text).toBe('override de p1')
  })

  it('tira error legible si el archivo no existe', () => {
    expect(() => new YamlSystemPromptRepository(join(dir, 'missing.yaml'))).toThrow(
      /no se pudo leer/,
    )
  })

  it('tira error legible si el YAML no matchea el schema', () => {
    const filePath = writeFile(`
- id: sin-text
  name: Sin text
`)
    expect(() => new YamlSystemPromptRepository(filePath)).toThrow(/SystemPromptDefSchema/)
  })

  it('los métodos de escritura tiran — el repo es read-only', () => {
    const filePath = writeFile(`
- id: a
  name: A
  text: x
`)
    const repo = new YamlSystemPromptRepository(filePath)

    expect(() => repo.upsert({ id: 'a', name: 'A', text: 'x' }, 0)).toThrow(/solo lectura/)
    expect(() => repo.deleteById('a')).toThrow(/solo lectura/)
    expect(() => repo.clearScope(null)).toThrow(/solo lectura/)
  })
})
