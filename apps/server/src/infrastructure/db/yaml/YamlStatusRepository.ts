import { readFileSync } from 'fs'
import { type StatusConfig, StatusConfigSchema } from '@ia-flow/shared'
import { parse as parseYaml } from 'yaml'
import type { IStatusRepository } from '../../../domain/ports/IStatusRepository.js'

// Read-only IStatusRepository backed by a static YAML file instead of the
// `statuses` SQLite table. Same rationale as YamlAgentRepository: a fixed
// engine deployment ships its pipeline stages as deploy config, not
// something edited at runtime through the CRUD UI. Mutating methods throw
// instead of silently no-op-ing so a stray call fails loud rather than
// pretending to persist.
const YAML_STATUS_SCHEMA = StatusConfigSchema.array()

function readStatuses(filePath: string): StatusConfig[] {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf-8')
  } catch (err) {
    throw new Error(
      `YamlStatusRepository: no se pudo leer '${filePath}': ${(err as Error).message}`,
    )
  }

  const parsed = parseYaml(raw)
  const result = YAML_STATUS_SCHEMA.safeParse(parsed ?? [])
  if (!result.success) {
    throw new Error(
      `YamlStatusRepository: '${filePath}' no cumple StatusConfigSchema[]: ${result.error.message}`,
    )
  }
  return result.data
}

function readOnly(op: string): never {
  throw new Error(
    `YamlStatusRepository es de solo lectura (${op} no soportado) — editá el archivo YAML y reiniciá el proceso.`,
  )
}

export class YamlStatusRepository implements IStatusRepository {
  // Loaded once at construction — see YamlAgentRepository for rationale.
  private readonly statuses: StatusConfig[]

  constructor(filePath: string) {
    // SqliteStatusRepository orders by declared `position` within a
    // project; sort once here the same way, falling back to file order
    // when a row doesn't set one.
    this.statuses = readStatuses(filePath)
      .map((s, index) => ({ s, key: s.position ?? index }))
      .sort((x, y) => x.key - y.key)
      .map(({ s }) => s)
  }

  list(projectId?: string): StatusConfig[] {
    if (projectId === undefined) return [...this.statuses]
    return this.statuses.filter((s) => s.projectId === projectId)
  }

  getByName(projectId: string, name: string): StatusConfig | null {
    return this.statuses.find((s) => s.projectId === projectId && s.name === name) ?? null
  }

  upsert(_status: StatusConfig, _position: number, _projectId: string): void {
    readOnly('upsert')
  }

  deleteByName(_projectId: string, _name: string): void {
    readOnly('deleteByName')
  }

  clearScope(_projectId: string): void {
    readOnly('clearScope')
  }
}
