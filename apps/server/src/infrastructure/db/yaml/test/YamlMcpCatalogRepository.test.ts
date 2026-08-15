import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { YamlMcpCatalogRepository } from '../YamlMcpCatalogRepository.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yaml-mcp-catalog-repo-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeCatalogFile(yaml: string): string {
  const filePath = join(dir, 'mcp-catalog.yaml')
  writeFileSync(filePath, yaml)
  return filePath
}

describe('YamlMcpCatalogRepository', () => {
  it('carga entries desde YAML, en el orden declarado', () => {
    const filePath = writeCatalogFile(`
- id: github-mcp
  name: GitHub MCP
  description: Official GitHub remote MCP server
  config:
    type: http
    url: https://api.githubcopilot.com/mcp/
    authorizationToken: \${GITHUB_TOKEN}
- id: local-stdio
  name: Local stdio MCP
  config:
    command: npx
    args: ['-y', '@some/mcp-server']
`)
    const repo = new YamlMcpCatalogRepository(filePath)

    expect(repo.list().map((e) => e.id)).toEqual(['github-mcp', 'local-stdio'])
    expect(repo.get('github-mcp')?.name).toBe('GitHub MCP')
    expect(repo.get('local-stdio')?.config).toEqual({
      command: 'npx',
      args: ['-y', '@some/mcp-server'],
    })
  })

  it('get devuelve null para un id que no existe', () => {
    const filePath = writeCatalogFile(`
- id: only-entry
  name: Only Entry
  config:
    type: http
    url: https://example.com/mcp/
`)
    const repo = new YamlMcpCatalogRepository(filePath)

    expect(repo.get('missing')).toBeNull()
  })

  it('tira error legible si el archivo no existe', () => {
    expect(() => new YamlMcpCatalogRepository(join(dir, 'missing.yaml'))).toThrow(/no se pudo leer/)
  })

  it('tira error legible si el YAML no matchea el schema', () => {
    const filePath = writeCatalogFile(`
- id: sin-config
  name: Sin config
`)
    expect(() => new YamlMcpCatalogRepository(filePath)).toThrow(/McpCatalogEntrySchema/)
  })

  it('los métodos de escritura tiran — el repo es read-only', () => {
    const filePath = writeCatalogFile(`
- id: a
  name: A
  config:
    type: http
    url: https://example.com/mcp/
`)
    const repo = new YamlMcpCatalogRepository(filePath)

    expect(() =>
      repo.upsert({ id: 'a', name: 'A', config: { type: 'http', url: 'https://x' } }, 0),
    ).toThrow(/solo lectura/)
    expect(() => repo.deleteById('a')).toThrow(/solo lectura/)
  })
})
