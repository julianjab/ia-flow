import { readFileSync } from 'fs'
import { type YamlGlobalSettings, YamlGlobalSettingsSchema } from '@ia-flow/shared'
import { parse as parseYaml } from 'yaml'
import type { IGlobalSettingsRepository } from '../../../domain/ports/IGlobalSettingsRepository.js'

// Read-only IGlobalSettingsRepository backed by a static YAML file instead
// of the `global_settings` SQLite table. Same rationale as
// YamlAgentRepository: a fixed engine deployment ships its settings as
// deploy config, not something edited at runtime through the CRUD UI.
// Mutating methods throw instead of silently no-op-ing so a stray call
// fails loud rather than pretending to persist.
//
// Unlike the array-backed Yaml*Repository files, this YAML is a single
// object (see YamlGlobalSettingsSchema) — there's no list of rows to sort
// or filter, just `values` (raw key/value overrides) and `scanRoots`.

function readSettings(filePath: string): YamlGlobalSettings {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf-8')
  } catch (err) {
    throw new Error(
      `YamlGlobalSettingsRepository: no se pudo leer '${filePath}': ${(err as Error).message}`,
    )
  }

  const parsed = parseYaml(raw)
  const result = YamlGlobalSettingsSchema.safeParse(parsed ?? {})
  if (!result.success) {
    throw new Error(
      `YamlGlobalSettingsRepository: '${filePath}' no cumple YamlGlobalSettingsSchema: ${result.error.message}`,
    )
  }
  return result.data
}

function readOnly(op: string): never {
  throw new Error(
    `YamlGlobalSettingsRepository es de solo lectura (${op} no soportado) — editá el archivo YAML y reiniciá el proceso.`,
  )
}

export class YamlGlobalSettingsRepository implements IGlobalSettingsRepository {
  // Loaded once at construction — see YamlAgentRepository for rationale.
  private readonly settings: YamlGlobalSettings

  constructor(filePath: string) {
    this.settings = readSettings(filePath)
  }

  getAll(): Record<string, string> {
    return { ...(this.settings.values ?? {}) }
  }

  get(key: string): string | null {
    return this.settings.values?.[key] ?? null
  }

  set(_key: string, _value: string): void {
    readOnly('set')
  }

  setMany(_settings: Record<string, string>): void {
    readOnly('setMany')
  }

  delete(_key: string): void {
    readOnly('delete')
  }

  getScanRoots(): string[] {
    return this.settings.scanRoots ?? []
  }

  setScanRoots(_roots: string[]): void {
    readOnly('setScanRoots')
  }
}
