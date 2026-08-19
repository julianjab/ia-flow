import { readFileSync } from 'fs'
import { type SystemPromptDef, SystemPromptDefSchema } from '@ia-flow/shared'
import { parse as parseYaml } from 'yaml'
import type { ISystemPromptRepository } from '../../../domain/ports/ISystemPromptRepository.js'

// Read-only ISystemPromptRepository backed by a static YAML file instead of
// the `system_prompts` SQLite table. Same rationale as YamlAgentRepository:
// a fixed engine deployment ships its prompt roster as deploy config, not
// something edited at runtime through the CRUD UI. Mutating methods throw
// instead of silently no-op-ing so a stray call fails loud rather than
// pretending to persist.
const YAML_SYSTEM_PROMPT_SCHEMA = SystemPromptDefSchema.array()

function readSystemPrompts(filePath: string): SystemPromptDef[] {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf-8')
  } catch (err) {
    throw new Error(
      `YamlSystemPromptRepository: no se pudo leer '${filePath}': ${(err as Error).message}`,
    )
  }

  const parsed = parseYaml(raw)
  const result = YAML_SYSTEM_PROMPT_SCHEMA.safeParse(parsed ?? [])
  if (!result.success) {
    throw new Error(
      `YamlSystemPromptRepository: '${filePath}' no cumple SystemPromptDefSchema[]: ${result.error.message}`,
    )
  }
  return result.data
}

function readOnly(op: string): never {
  throw new Error(
    `YamlSystemPromptRepository es de solo lectura (${op} no soportado) — editá el archivo YAML y reiniciá el proceso.`,
  )
}

export class YamlSystemPromptRepository implements ISystemPromptRepository {
  // Loaded once at construction — see YamlAgentRepository for rationale.
  private readonly prompts: SystemPromptDef[]

  constructor(filePath: string) {
    this.prompts = readSystemPrompts(filePath)
  }

  getById(id: string): SystemPromptDef | null {
    return this.prompts.find((sp) => sp.id === id) ?? null
  }

  inScope(projectId?: string | null): SystemPromptDef[] {
    if (projectId === undefined) return [...this.prompts]
    if (projectId === null) return this.prompts.filter((sp) => sp.projectId == null)
    return this.prompts.filter((sp) => sp.projectId === projectId)
  }

  visibleTo(projectId: string): SystemPromptDef[] {
    const byId = new Map<string, SystemPromptDef>()
    for (const sp of this.prompts) {
      if (sp.projectId !== projectId && sp.projectId != null) continue
      const existing = byId.get(sp.id)
      if (!existing || (existing.projectId == null && sp.projectId != null)) byId.set(sp.id, sp)
    }
    return Array.from(byId.values())
  }

  upsert(_sp: SystemPromptDef, _position: number, _projectId?: string | null): void {
    readOnly('upsert')
  }

  deleteById(_id: string): void {
    readOnly('deleteById')
  }

  clearScope(_projectId: string | null): void {
    readOnly('clearScope')
  }
}
