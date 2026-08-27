import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { YamlAgentMemoryRepository } from '../YamlAgentMemoryRepository.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yaml-agent-memory-repo-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeMemoryFile(yaml: string): string {
  const filePath = join(dir, 'agent-memories.yaml')
  writeFileSync(filePath, yaml)
  return filePath
}

const SAMPLE = `
- agentId: builder
  projectId: p1
  key: deploy_channel
  value: "#infra"
  updatedAt: "2026-08-27T00:00:00.000Z"
- agentId: builder
  projectId: p1
  key: alfa
  value: "primero por orden"
  updatedAt: "2026-08-27T00:00:00.000Z"
- agentId: reviewer
  projectId: p1
  key: deploy_channel
  value: "#reviews"
  updatedAt: "2026-08-27T00:00:00.000Z"
`

describe('YamlAgentMemoryRepository', () => {
  it('lee entries del YAML y las expone por namespace', () => {
    const repo = new YamlAgentMemoryRepository(writeMemoryFile(SAMPLE))
    expect(repo.get('builder', 'p1', 'deploy_channel')?.value).toBe('#infra')
    expect(repo.get('reviewer', 'p1', 'deploy_channel')?.value).toBe('#reviews')
    expect(repo.get('builder', 'p2', 'deploy_channel')).toBeNull()
  })

  it('list ordena por key dentro del namespace', () => {
    const repo = new YamlAgentMemoryRepository(writeMemoryFile(SAMPLE))
    expect(repo.list('builder', 'p1').map((e) => e.key)).toEqual(['alfa', 'deploy_channel'])
  })

  it('search filtra por key o value dentro del namespace', () => {
    const repo = new YamlAgentMemoryRepository(writeMemoryFile(SAMPLE))
    expect(repo.search('builder', 'p1', 'INFRA').map((e) => e.key)).toEqual(['deploy_channel'])
    expect(repo.search('builder', 'p1', 'reviews')).toEqual([])
  })

  it('projectId ausente cae a la memoria global del agente', () => {
    const repo = new YamlAgentMemoryRepository(
      writeMemoryFile(`
- agentId: builder
  key: convencion
  value: commits en español
  updatedAt: "2026-08-27T00:00:00.000Z"
`),
    )
    expect(repo.get('builder', '', 'convencion')?.value).toBe('commits en español')
  })

  it('acepta entradas ya parseadas (el flavor runner, sin archivo propio)', () => {
    const repo = new YamlAgentMemoryRepository([
      { agentId: 'a', projectId: '', key: 'k', value: 'v', updatedAt: '2026-08-27T00:00:00.000Z' },
    ])
    expect(repo.get('a', '', 'k')?.value).toBe('v')
  })

  it('tira error legible si el archivo no existe', () => {
    expect(() => new YamlAgentMemoryRepository(join(dir, 'no-existe.yaml'))).toThrow(
      /no se pudo leer/,
    )
  })

  it('tira error legible si el YAML no matchea el schema', () => {
    const filePath = writeMemoryFile('- agentId: builder\n  key: k\n')
    expect(() => new YamlAgentMemoryRepository(filePath)).toThrow(/AgentMemoryEntrySchema/)
  })

  it('los métodos de escritura tiran — el repo es read-only', () => {
    const repo = new YamlAgentMemoryRepository(writeMemoryFile(SAMPLE))
    expect(() =>
      repo.upsert({
        agentId: 'builder',
        projectId: 'p1',
        key: 'k',
        value: 'v',
        updatedAt: '2026-08-27T00:00:00.000Z',
      }),
    ).toThrow(/solo lectura/)
    expect(() => repo.deleteByKey('builder', 'p1', 'deploy_channel')).toThrow(/solo lectura/)
  })
})
