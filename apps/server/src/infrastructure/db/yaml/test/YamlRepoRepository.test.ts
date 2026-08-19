import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { YamlRepoRepository } from '../YamlRepoRepository.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yaml-repo-repo-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeFile(yaml: string): string {
  const filePath = join(dir, 'repos.yaml')
  writeFileSync(filePath, yaml)
  return filePath
}

describe('YamlRepoRepository', () => {
  it('listByProject / getByProject filtran por proyecto', () => {
    const filePath = writeFile(`
- name: api
  projectId: p1
  path: /repos/api
- name: web
  projectId: p1
- name: other
  projectId: p2
`)
    const repo = new YamlRepoRepository(filePath)

    expect(repo.listByProject('p1').map((r) => r.name)).toEqual(['api', 'web'])
    expect(repo.getByProject('api', 'p1')?.path).toBe('/repos/api')
    expect(repo.getByProject('api', 'p2')).toBeNull()
  })

  it('list() / get() son lookups por nombre a través de todos los proyectos', () => {
    const filePath = writeFile(`
- name: api
  projectId: p1
`)
    const repo = new YamlRepoRepository(filePath)

    expect(repo.list().map((r) => r.name)).toEqual(['api'])
    expect(repo.get('api')?.projectId).toBe('p1')
    expect(repo.get('missing')).toBeNull()
  })

  it('findByGithubRepo / findByPath filtran cross-project', () => {
    const filePath = writeFile(`
- name: api
  projectId: p1
  githubOwner: acme
  githubRepo: api
  path: /repos/api
- name: api-fork
  projectId: p2
  githubOwner: acme
  githubRepo: api
`)
    const repo = new YamlRepoRepository(filePath)

    expect(
      repo
        .findByGithubRepo('acme', 'api')
        .map((r) => r.name)
        .sort(),
    ).toEqual(['api', 'api-fork'])
    expect(repo.findByPath('/repos/api').map((r) => r.name)).toEqual(['api'])
  })

  it('toMapping computa el RepoMapping legado a partir de listByProject', () => {
    const filePath = writeFile(`
- name: api
  projectId: p1
  githubRepo: acme/api
`)
    const repo = new YamlRepoRepository(filePath)

    expect(repo.toMapping('p1')).toEqual({ api: { githubRepo: 'acme/api' } })
  })

  it('tira error legible si el archivo no existe', () => {
    expect(() => new YamlRepoRepository(join(dir, 'missing.yaml'))).toThrow(/no se pudo leer/)
  })

  it('tira error legible si el YAML no matchea el schema', () => {
    const filePath = writeFile(`
- name: sin-project
`)
    expect(() => new YamlRepoRepository(filePath)).toThrow(/RepoDefSchema/)
  })

  it('los métodos de escritura tiran — el repo es read-only', () => {
    const filePath = writeFile(`
- name: api
  projectId: p1
`)
    const repo = new YamlRepoRepository(filePath)

    expect(() => repo.upsert({ name: 'api', projectId: 'p1' })).toThrow(/solo lectura/)
    expect(() => repo.deleteByProject('api', 'p1')).toThrow(/solo lectura/)
    expect(() => repo.bulkSet({}, 'p1')).toThrow(/solo lectura/)
  })
})
