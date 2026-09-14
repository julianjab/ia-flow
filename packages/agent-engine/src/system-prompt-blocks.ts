// Resuelve los bloques de system prompt que se mandan a la API de Anthropic
// (AnthropicApiSettingsSchema.systemPrompt), en orden general → específico:
//
//   1. `ProjectConfig.project.systemPrompts[]` — default del PROYECTO,
//      aplica a todos sus agentes sin que cada uno liste nada.
//   2. `ProjectConfig.systemPrompts[].default === true` — prompts reusables
//      marcados como default, mismo alcance automático (ya vienen filtrados
//      por scope — global o el proyecto — antes de llegar acá, ver
//      ISystemPromptRepository.visibleTo).
//   3. `AgentDefinition.systemPrompts[]` — lo que el agente eligió, en el
//      orden en que lo declaró.
//
// Cada entrada de un array `systemPrompts[]` (1 y 3) es un `SystemPromptRef`:
// o un id (string) que se resuelve contra `ProjectConfig.systemPrompts`, o
// texto inline (`{text}`) que se usa tal cual. Un id ya incluido por (1) o
// (2) no se duplica si el agente también lo referencia en (3).
import type {
  AgentDefinition,
  AgentToolEntry,
  ProjectConfig,
  SystemPromptDef,
  SystemPromptRef,
} from '@ia-flow/shared'

export interface SystemPromptBlock {
  type: 'text'
  text: string
}

// Cualquiera de las tres basta para que valga la pena avisarle al agente que
// consulte su memoria — no exigimos las tres porque un agente puede declarar
// sólo `memory_retrieve` (sabe la key) o sólo `memory_search`/`memory_list`
// (no la sabe).
const MEMORY_READ_TOOLS = new Set(['memory_retrieve', 'memory_search', 'memory_list'])

function hasMemoryReadTools(tools: AgentToolEntry[] | undefined): boolean {
  if (!tools?.length) return false
  return tools.some((t) => MEMORY_READ_TOOLS.has(typeof t === 'string' ? t : t.name))
}

/**
 * Recordatorio explícito de usar la memoria — sin esto, un agente con las
 * tools `memory_*` habilitadas no las llama de forma consistente sólo porque
 * están disponibles: un LLM no invoca una tool espontáneamente en cada
 * corrida a menos que el prompt se lo pida. Va al FINAL de los bloques (no al
 * principio) para que quede como lo último que el agente lee antes de
 * arrancar a trabajar, después de todo el contexto específico del proyecto y
 * del agente.
 */
const MEMORY_GUIDANCE =
  'Tenés memoria persistente entre tus corridas sobre esta tarea. ANTES de ' +
  'empezar a trabajar, llamá `memory_retrieve` (si sabés bajo qué key ' +
  'guardaste algo relevante) o `memory_search`/`memory_list` (si no la ' +
  'sabés) para ver qué dejaste anotado la última vez: decisiones tomadas, ' +
  'convenciones del repo, gotchas. No asumas que no hay nada guardado — ' +
  'consultarla es barato, e ignorarla te hace repetir trabajo o pisar una ' +
  'decisión que ya habías tomado.'

function pushRef(
  blocks: SystemPromptBlock[],
  includedIds: Set<string>,
  ref: SystemPromptRef,
  catalog: SystemPromptDef[] | undefined,
): void {
  if (typeof ref === 'string') {
    if (includedIds.has(ref)) return
    const sp = catalog?.find((s) => s.id === ref)
    if (sp) {
      blocks.push({ type: 'text', text: sp.text })
      includedIds.add(sp.id)
    }
  } else {
    blocks.push({ type: 'text', text: ref.text })
  }
}

export function resolveSystemPromptBlocks(
  agentDef: Pick<AgentDefinition, 'systemPrompts' | 'tools'>,
  config: Pick<ProjectConfig, 'project' | 'systemPrompts'>,
): SystemPromptBlock[] {
  const blocks: SystemPromptBlock[] = []
  const includedIds = new Set<string>()

  for (const ref of config.project?.systemPrompts ?? []) {
    pushRef(blocks, includedIds, ref, config.systemPrompts)
  }

  for (const sp of config.systemPrompts ?? []) {
    if (sp.default && !includedIds.has(sp.id)) {
      blocks.push({ type: 'text', text: sp.text })
      includedIds.add(sp.id)
    }
  }

  for (const ref of agentDef.systemPrompts ?? []) {
    pushRef(blocks, includedIds, ref, config.systemPrompts)
  }

  if (hasMemoryReadTools(agentDef.tools)) {
    blocks.push({ type: 'text', text: MEMORY_GUIDANCE })
  }

  return blocks
}
