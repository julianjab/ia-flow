import { readFileSync } from 'fs'
import type { StepType, YamlPromptCatalog } from '@ia-flow/shared'
import { YamlPromptCatalogSchema } from '@ia-flow/shared'
import { parse as parseYaml } from 'yaml'
import type { IPromptRepository } from '../../../domain/ports/IPromptRepository.js'

// Read-only IPromptRepository backed by a static YAML file instead of the
// `global_settings` rows (`prompt.<step>` / `util.<key>` / `provider_config`)
// that SqlitePromptRepository reads/writes. Same rationale as
// YamlAgentRepository: a fixed engine deployment ships its prompts as
// deploy config, not something edited at runtime through the CRUD UI.
// Mutating methods throw instead of silently no-op-ing so a stray call
// fails loud rather than pretending to persist.
//
// Unlike the array-backed Yaml*Repository files, this YAML is a single
// object (see YamlPromptCatalogSchema).

function readCatalog(filePath: string): YamlPromptCatalog {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf-8')
  } catch (err) {
    throw new Error(
      `YamlPromptRepository: no se pudo leer '${filePath}': ${(err as Error).message}`,
    )
  }

  const parsed = parseYaml(raw)
  const result = YamlPromptCatalogSchema.safeParse(parsed ?? {})
  if (!result.success) {
    throw new Error(
      `YamlPromptRepository: '${filePath}' no cumple YamlPromptCatalogSchema: ${result.error.message}`,
    )
  }
  return result.data
}

function readOnly(op: string): never {
  throw new Error(
    `YamlPromptRepository es de solo lectura (${op} no soportado) — editá el archivo YAML y reiniciá el proceso.`,
  )
}

export class YamlPromptRepository implements IPromptRepository {
  // Loaded once at construction — see YamlAgentRepository for rationale.
  private readonly catalog: YamlPromptCatalog

  constructor(filePath: string) {
    this.catalog = readCatalog(filePath)
  }

  getPhasePrompt(step: StepType): string | null {
    return this.catalog.phasePrompts?.[step] ?? null
  }

  setPhasePrompt(_step: StepType, _prompt: string): void {
    readOnly('setPhasePrompt')
  }

  getUtilityPrompt(key: string): string | null {
    return this.catalog.utilityPrompts?.[key] ?? null
  }

  setUtilityPrompt(_key: string, _prompt: string): void {
    readOnly('setUtilityPrompt')
  }

  getProviderConfigBlob(): Record<string, unknown> | null {
    return this.catalog.providerConfig ?? null
  }

  setProviderConfigBlob(_config: Record<string, unknown>): void {
    readOnly('setProviderConfigBlob')
  }

  deleteProviderConfigBlob(): void {
    readOnly('deleteProviderConfigBlob')
  }
}
