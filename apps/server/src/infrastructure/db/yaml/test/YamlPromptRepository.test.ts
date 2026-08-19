import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { YamlPromptRepository } from '../YamlPromptRepository.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yaml-prompt-repo-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeFile(yaml: string): string {
  const filePath = join(dir, 'prompts.yaml')
  writeFileSync(filePath, yaml)
  return filePath
}

describe('YamlPromptRepository', () => {
  it('carga un objeto plano de phasePrompts + utilityPrompts + providerConfig', () => {
    const filePath = writeFile(`
phasePrompts:
  refine-functional: prompt de refine
utilityPrompts:
  greeting: hola
providerConfig:
  steps: {}
  anthropicApi:
    model: claude-sonnet
    anthropicVersion: '2023-06-01'
    anthropicBeta: []
    systemPrompt: []
`)
    const repo = new YamlPromptRepository(filePath)

    expect(repo.getPhasePrompt('refine-functional')).toBe('prompt de refine')
    expect(repo.getPhasePrompt('implement')).toBeNull()
    expect(repo.getUtilityPrompt('greeting')).toBe('hola')
    expect(repo.getUtilityPrompt('missing')).toBeNull()
    expect(repo.getProviderConfigBlob()).toEqual({
      steps: {},
      anthropicApi: {
        model: 'claude-sonnet',
        anthropicVersion: '2023-06-01',
        anthropicBeta: [],
        systemPrompt: [],
      },
    })
  })

  it('acepta un YAML vacío — todo cae a null', () => {
    const filePath = writeFile('')
    const repo = new YamlPromptRepository(filePath)

    expect(repo.getPhasePrompt('implement')).toBeNull()
    expect(repo.getUtilityPrompt('anything')).toBeNull()
    expect(repo.getProviderConfigBlob()).toBeNull()
  })

  it('tira error legible si el archivo no existe', () => {
    expect(() => new YamlPromptRepository(join(dir, 'missing.yaml'))).toThrow(/no se pudo leer/)
  })

  it('tira error legible si el YAML no matchea el schema', () => {
    const filePath = writeFile(`
phasePrompts:
  not-a-step: x
`)
    expect(() => new YamlPromptRepository(filePath)).toThrow(/YamlPromptCatalogSchema/)
  })

  it('los métodos de escritura tiran — el repo es read-only', () => {
    const filePath = writeFile(`
phasePrompts:
  implement: x
`)
    const repo = new YamlPromptRepository(filePath)

    expect(() => repo.setPhasePrompt('implement', 'y')).toThrow(/solo lectura/)
    expect(() => repo.setUtilityPrompt('k', 'v')).toThrow(/solo lectura/)
    expect(() => repo.setProviderConfigBlob({})).toThrow(/solo lectura/)
    expect(() => repo.deleteProviderConfigBlob()).toThrow(/solo lectura/)
  })
})
