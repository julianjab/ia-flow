import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { YamlStatusRepository } from '../YamlStatusRepository.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yaml-status-repo-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeFile(yaml: string): string {
  const filePath = join(dir, 'statuses.yaml')
  writeFileSync(filePath, yaml)
  return filePath
}

describe('YamlStatusRepository', () => {
  it('list() sin projectId devuelve todos, ordenados por position', () => {
    const filePath = writeFile(`
- name: Build
  projectId: p1
  position: 2
- name: Refine
  projectId: p1
  position: 0
- name: Other
  projectId: p2
  position: 0
`)
    const repo = new YamlStatusRepository(filePath)

    expect(repo.list().map((s) => s.name)).toEqual(['Refine', 'Other', 'Build'])
  })

  it('list(projectId) filtra por proyecto', () => {
    const filePath = writeFile(`
- name: Refine
  projectId: p1
  position: 0
- name: Build
  projectId: p1
  position: 1
- name: Other
  projectId: p2
  position: 0
`)
    const repo = new YamlStatusRepository(filePath)

    expect(repo.list('p1').map((s) => s.name)).toEqual(['Refine', 'Build'])
  })

  it('getByName busca por proyecto + nombre', () => {
    const filePath = writeFile(`
- name: Refine
  projectId: p1
  position: 0
  allowBlocked: true
`)
    const repo = new YamlStatusRepository(filePath)

    expect(repo.getByName('p1', 'Refine')?.allowBlocked).toBe(true)
    expect(repo.getByName('p1', 'missing')).toBeNull()
    expect(repo.getByName('p2', 'Refine')).toBeNull()
  })

  it('tira error legible si el archivo no existe', () => {
    expect(() => new YamlStatusRepository(join(dir, 'missing.yaml'))).toThrow(/no se pudo leer/)
  })

  it('tira error legible si el YAML no matchea el schema', () => {
    const filePath = writeFile(`
- projectId: p1
`)
    expect(() => new YamlStatusRepository(filePath)).toThrow(/StatusConfigSchema/)
  })

  it('los métodos de escritura tiran — el repo es read-only', () => {
    const filePath = writeFile(`
- name: Refine
  projectId: p1
  position: 0
`)
    const repo = new YamlStatusRepository(filePath)

    expect(() => repo.upsert({ name: 'Refine', projectId: 'p1' }, 0, 'p1')).toThrow(/solo lectura/)
    expect(() => repo.deleteByName('p1', 'Refine')).toThrow(/solo lectura/)
    expect(() => repo.clearScope('p1')).toThrow(/solo lectura/)
  })
})
