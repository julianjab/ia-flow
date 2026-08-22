import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { YamlAgentRepository } from '../YamlAgentRepository.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yaml-agent-repo-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeAgentsFile(yaml: string): string {
  const filePath = join(dir, 'agents.yaml')
  writeFileSync(filePath, yaml)
  return filePath
}

describe('YamlAgentRepository', () => {
  it('isReadOnly() es true — es un roster de deploy fijo', () => {
    const filePath = writeAgentsFile('[]')
    expect(new YamlAgentRepository(filePath).isReadOnly()).toBe(true)
  })

  it('carga agentes globales y por proyecto desde YAML', () => {
    const filePath = writeAgentsFile(`
- id: functional-refiner
  provider: anthropic
  prompt: refina la tarea
  presetId: refiner
- id: scoped
  provider: anthropic
  prompt: solo para p1
  projectId: p1
`)
    const repo = new YamlAgentRepository(filePath)

    expect(repo.inScope(undefined).map((a) => a.id)).toEqual(['functional-refiner', 'scoped'])
    expect(repo.inScope(null).map((a) => a.id)).toEqual(['functional-refiner'])
    expect(repo.inScope('p1').map((a) => a.id)).toEqual(['scoped'])
  })

  it('visibleTo devuelve globales + los de ese proyecto, con shadow del scoped', () => {
    const filePath = writeAgentsFile(`
- id: dup
  provider: anthropic
  prompt: global
- id: dup
  provider: anthropic
  prompt: override de p1
  projectId: p1
- id: other-project
  provider: anthropic
  prompt: no debe aparecer
  projectId: p2
`)
    const repo = new YamlAgentRepository(filePath)
    const visible = repo.visibleTo('p1')

    expect(visible.map((a) => a.id).sort()).toEqual(['dup'])
    expect(visible.find((a) => a.id === 'dup')?.prompt).toBe('override de p1')
  })

  it('ordena por position declarada, y por orden del archivo cuando falta', () => {
    const filePath = writeAgentsFile(`
- id: third
  provider: anthropic
  prompt: x
  position: 2
- id: no-position-first
  provider: anthropic
  prompt: x
- id: first
  provider: anthropic
  prompt: x
  position: 0
- id: no-position-second
  provider: anthropic
  prompt: x
`)
    const repo = new YamlAgentRepository(filePath)

    // 'no-position-first' cae en el índice 1 del archivo → esa es su key de
    // orden cuando no declara position; termina entre 'first' (0) y 'third' (2).
    expect(repo.inScope(undefined).map((a) => a.id)).toEqual([
      'first',
      'no-position-first',
      'third',
      'no-position-second',
    ])
  })

  it('tira error legible si el archivo no existe', () => {
    expect(() => new YamlAgentRepository(join(dir, 'missing.yaml'))).toThrow(/no se pudo leer/)
  })

  it('tira error legible si el YAML no matchea el schema', () => {
    const filePath = writeAgentsFile(`
- id: sin-prompt
  provider: anthropic
`)
    expect(() => new YamlAgentRepository(filePath)).toThrow(/AgentDefinitionSchema/)
  })

  it('los métodos de escritura tiran — el repo es read-only', () => {
    const filePath = writeAgentsFile(`
- id: a
  provider: anthropic
  prompt: x
`)
    const repo = new YamlAgentRepository(filePath)

    expect(() => repo.upsert({ id: 'a', provider: 'anthropic', prompt: 'x' }, 0)).toThrow(
      /solo lectura/,
    )
    expect(() => repo.deleteById('a')).toThrow(/solo lectura/)
    expect(() => repo.clearScope(null)).toThrow(/solo lectura/)
    expect(() => repo.setPositions(['a'], null)).toThrow(/solo lectura/)
  })
})
