import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { YamlProjectRepository } from '../YamlProjectRepository.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yaml-project-repo-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeFile(yaml: string): string {
  const filePath = join(dir, 'projects.yaml')
  writeFileSync(filePath, yaml)
  return filePath
}

describe('YamlProjectRepository', () => {
  it('carga proyectos desde YAML y list() excluye archivados por default', () => {
    const filePath = writeFile(`
- id: p1
  name: Project One
- id: p2
  name: Project Two
  archivedAt: '2024-01-01T00:00:00.000Z'
`)
    const repo = new YamlProjectRepository(filePath)

    expect(repo.list().map((p) => p.id)).toEqual(['p1'])
    expect(repo.list(true).map((p) => p.id)).toEqual(['p1', 'p2'])
  })

  it('get busca por id', () => {
    const filePath = writeFile(`
- id: p1
  name: Project One
`)
    const repo = new YamlProjectRepository(filePath)

    expect(repo.get('p1')?.name).toBe('Project One')
    expect(repo.get('missing')).toBeNull()
  })

  it('getDefaultId devuelve el primer proyecto no archivado en orden del archivo', () => {
    const filePath = writeFile(`
- id: archived-first
  name: Archived
  archivedAt: '2024-01-01T00:00:00.000Z'
- id: first-active
  name: First Active
- id: second-active
  name: Second Active
`)
    const repo = new YamlProjectRepository(filePath)

    expect(repo.getDefaultId()).toBe('first-active')
  })

  it('getDefaultId tira si no hay ningún proyecto no archivado', () => {
    const filePath = writeFile(`
- id: p1
  name: Archived
  archivedAt: '2024-01-01T00:00:00.000Z'
`)
    const repo = new YamlProjectRepository(filePath)

    expect(() => repo.getDefaultId()).toThrow()
  })

  it('tira error legible si el archivo no existe', () => {
    expect(() => new YamlProjectRepository(join(dir, 'missing.yaml'))).toThrow(/no se pudo leer/)
  })

  it('tira error legible si el YAML no matchea el schema', () => {
    const filePath = writeFile(`
- name: Sin id
`)
    expect(() => new YamlProjectRepository(filePath)).toThrow(/ProjectSchema/)
  })

  it('los métodos de escritura tiran — el repo es read-only', () => {
    const filePath = writeFile(`
- id: p1
  name: Project One
`)
    const repo = new YamlProjectRepository(filePath)

    expect(() => repo.upsert({ id: 'p1', name: 'Project One' })).toThrow(/solo lectura/)
    expect(() => repo.archive('p1')).toThrow(/solo lectura/)
    expect(() => repo.deleteCascade('p1')).toThrow(/solo lectura/)
  })
})
