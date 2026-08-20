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
  ProjectConfig,
  SystemPromptDef,
  SystemPromptRef,
} from '@ia-flow/shared'

export interface SystemPromptBlock {
  type: 'text'
  text: string
}

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
  agentDef: Pick<AgentDefinition, 'systemPrompts'>,
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

  return blocks
}
