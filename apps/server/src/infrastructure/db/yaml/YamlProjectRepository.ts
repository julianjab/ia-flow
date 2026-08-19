import { readFileSync } from 'fs'
import { type Project, ProjectSchema } from '@ia-flow/shared'
import { parse as parseYaml } from 'yaml'
import type { IProjectRepository, ProjectInput } from '../../../domain/ports/IProjectRepository.js'

// Read-only IProjectRepository backed by a static YAML file instead of the
// `projects` SQLite table. Same rationale as YamlAgentRepository: a fixed
// engine deployment ships its project roster as deploy config, not
// something edited at runtime through the CRUD UI. Mutating methods throw
// instead of silently no-op-ing so a stray call fails loud rather than
// pretending to persist.
const YAML_PROJECT_SCHEMA = ProjectSchema.array()

function readProjects(filePath: string): Project[] {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf-8')
  } catch (err) {
    throw new Error(
      `YamlProjectRepository: no se pudo leer '${filePath}': ${(err as Error).message}`,
    )
  }

  const parsed = parseYaml(raw)
  const result = YAML_PROJECT_SCHEMA.safeParse(parsed ?? [])
  if (!result.success) {
    throw new Error(
      `YamlProjectRepository: '${filePath}' no cumple ProjectSchema[]: ${result.error.message}`,
    )
  }
  return result.data
}

function readOnly(op: string): never {
  throw new Error(
    `YamlProjectRepository es de solo lectura (${op} no soportado) — editá el archivo YAML y reiniciá el proceso.`,
  )
}

export class YamlProjectRepository implements IProjectRepository {
  // Loaded once at construction — see YamlAgentRepository for rationale.
  private readonly projects: Project[]

  constructor(filePath: string) {
    this.projects = readProjects(filePath)
  }

  getDefaultId(): string {
    // SqliteProjectRepository picks the oldest non-archived project by
    // created_at; a static file has no timestamp column to sort by, so the
    // declared array order stands in for "oldest first".
    const first = this.projects.find((p) => p.archivedAt == null)
    if (!first) {
      throw new Error('YamlProjectRepository: no hay ningún proyecto no archivado en el YAML')
    }
    return first.id
  }

  list(includeArchived = false): Project[] {
    return includeArchived ? [...this.projects] : this.projects.filter((p) => p.archivedAt == null)
  }

  get(id: string): Project | null {
    return this.projects.find((p) => p.id === id) ?? null
  }

  upsert(_input: ProjectInput): Project {
    readOnly('upsert')
  }

  archive(_id: string): void {
    readOnly('archive')
  }

  deleteCascade(_id: string): void {
    readOnly('deleteCascade')
  }
}
