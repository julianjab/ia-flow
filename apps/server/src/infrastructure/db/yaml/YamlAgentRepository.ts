import { readFileSync } from 'fs'
import { type AgentDefinition, AgentDefinitionSchema } from '@ia-flow/shared'
import { parse as parseYaml } from 'yaml'
import type { IAgentRepository } from '../../../domain/ports/IAgentRepository.js'

// Read-only IAgentRepository backed by a static YAML file instead of the
// `agents` SQLite table. Built for single-purpose engine deployments (e.g.
// a container that only ever runs one refiner) where the agent roster is
// part of the image/deploy config, not something edited at runtime through
// the CRUD UI. Mutating methods throw instead of silently no-op-ing so a
// stray `agents-crud` call fails loud rather than pretending to persist.
const YAML_AGENT_SCHEMA = AgentDefinitionSchema.array()

function readAgents(filePath: string): AgentDefinition[] {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf-8')
  } catch (err) {
    throw new Error(`YamlAgentRepository: no se pudo leer '${filePath}': ${(err as Error).message}`)
  }

  const parsed = parseYaml(raw)
  const result = YAML_AGENT_SCHEMA.safeParse(parsed ?? [])
  if (!result.success) {
    throw new Error(
      `YamlAgentRepository: '${filePath}' no cumple AgentDefinitionSchema[]: ${result.error.message}`,
    )
  }
  return result.data
}

function readOnly(op: string): never {
  throw new Error(
    `YamlAgentRepository es de solo lectura (${op} no soportado) — editá el archivo YAML y reiniciá el proceso.`,
  )
}

export class YamlAgentRepository implements IAgentRepository {
  // Loaded once at construction: this repo backs a static, deploy-time
  // roster (see class doc), so there is no writer to invalidate a cache
  // against — re-reading the file on every call would just add I/O.
  private readonly agents: AgentDefinition[]

  constructor(filePath: string) {
    // SqliteAgentRepository always orders by `position` (selectAgent picks
    // "first match by position"), so this has to match: sort once here by
    // declared `position`, falling back to file order (stable) when a row
    // doesn't set one — otherwise agent selection silently diverges from
    // what the YAML author intended.
    this.agents = readAgents(filePath)
      .map((a, index) => ({ a, key: a.position ?? index }))
      .sort((x, y) => x.key - y.key)
      .map(({ a }) => a)
  }

  isReadOnly(): boolean {
    return true
  }

  inScope(projectId?: string | null): AgentDefinition[] {
    if (projectId === undefined) return [...this.agents]
    if (projectId === null) return this.agents.filter((a) => a.projectId == null)
    return this.agents.filter((a) => a.projectId === projectId)
  }

  visibleTo(projectId: string): AgentDefinition[] {
    const byId = new Map<string, AgentDefinition>()
    for (const a of this.agents) {
      if (a.projectId !== projectId && a.projectId != null) continue
      const existing = byId.get(a.id)
      if (!existing || (existing.projectId == null && a.projectId != null)) byId.set(a.id, a)
    }
    return Array.from(byId.values())
  }

  upsert(_agent: AgentDefinition, _position: number, _projectId?: string | null): void {
    readOnly('upsert')
  }

  deleteById(_id: string): void {
    readOnly('deleteById')
  }

  clearScope(_projectId: string | null): void {
    readOnly('clearScope')
  }

  setPositions(_ids: string[], _projectId: string | null): void {
    readOnly('setPositions')
  }
}
