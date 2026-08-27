import { readFileSync } from 'fs'
import { type AgentMemoryEntry, AgentMemoryEntrySchema } from '@ia-flow/shared'
import { parse as parseYaml } from 'yaml'
import type { IAgentMemoryRepository } from '../../../domain/ports/IAgentMemoryRepository.js'

// IAgentMemoryRepository de SOLO LECTURA sobre un YAML estático, mismo patrón
// que YamlMcpCatalogRepository.
//
// Es el caso del deploy headless que quiere darle a sus agentes un contexto
// fijo ("el owner del repo es X", "el canal de deploys es Y") sin una DB
// escribible al lado. Las escrituras TIRAN en vez de no-opear en silencio: un
// agente que cree que guardó algo y no lo guardó es peor que uno que ve el
// error y sigue sin memoria.
const YAML_AGENT_MEMORY_SCHEMA = AgentMemoryEntrySchema.array()

function readEntries(filePath: string): AgentMemoryEntry[] {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf-8')
  } catch (err) {
    throw new Error(
      `YamlAgentMemoryRepository: no se pudo leer '${filePath}': ${(err as Error).message}`,
    )
  }

  const parsed = parseYaml(raw)
  const result = YAML_AGENT_MEMORY_SCHEMA.safeParse(parsed ?? [])
  if (!result.success) {
    throw new Error(
      `YamlAgentMemoryRepository: '${filePath}' no cumple AgentMemoryEntrySchema[]: ${result.error.message}`,
    )
  }
  return result.data
}

function readOnly(op: string): never {
  throw new Error(
    `YamlAgentMemoryRepository es de solo lectura (${op} no soportado) — editá el archivo YAML y reiniciá el proceso.`,
  )
}

export class YamlAgentMemoryRepository implements IAgentMemoryRepository {
  private readonly entries: AgentMemoryEntry[]

  /** Un path, o las entradas ya parseadas (el flavor `runner`, donde son una
   *  sección del `runner.yaml` único). */
  constructor(source: string | AgentMemoryEntry[]) {
    this.entries = typeof source === 'string' ? readEntries(source) : [...source]
  }

  private namespace(agentId: string, projectId: string): AgentMemoryEntry[] {
    return this.entries.filter((e) => e.agentId === agentId && e.projectId === projectId)
  }

  get(agentId: string, projectId: string, key: string): AgentMemoryEntry | null {
    return this.namespace(agentId, projectId).find((e) => e.key === key) ?? null
  }

  list(agentId: string, projectId: string): AgentMemoryEntry[] {
    return this.namespace(agentId, projectId).sort((a, b) => a.key.localeCompare(b.key))
  }

  search(agentId: string, projectId: string, term: string): AgentMemoryEntry[] {
    const needle = term.toLowerCase()
    return this.list(agentId, projectId).filter(
      (e) => e.key.toLowerCase().includes(needle) || e.value.toLowerCase().includes(needle),
    )
  }

  upsert(_entry: AgentMemoryEntry): void {
    readOnly('upsert')
  }

  deleteByKey(_agentId: string, _projectId: string, _key: string): boolean {
    readOnly('deleteByKey')
  }
}
