// Resuelve los bloques de system prompt que se mandan a la API de Anthropic
// (AnthropicApiSettingsSchema.systemPrompt), en orden general → específico:
//
//   1. `ProjectConfig.project.systemPrompt` — default del PROYECTO, aplica a
//      todos sus agentes sin que cada uno liste nada.
//   2. `ProjectConfig.systemPrompts[].default === true` — prompts reusables
//      marcados como default, mismo alcance automático (ya vienen filtrados
//      por scope — global o el proyecto — antes de llegar acá, ver
//      ISystemPromptRepository.visibleTo).
//   3. `AgentDefinition.systemPrompts[]` — ids explícitos que el agente eligió.
//   4. `AgentDefinition.inlineSystemPrompt` — texto propio del agente, sin
//      pasar por un SystemPromptDef.
//
// Un mismo id no se duplica si ya entró por (1)/(2) y el agente también lo
// referencia en (3).
import type { AgentDefinition, ProjectConfig } from '@ia-flow/shared'

export interface SystemPromptBlock {
  type: 'text'
  text: string
}

export function resolveSystemPromptBlocks(
  agentDef: Pick<AgentDefinition, 'systemPrompts' | 'inlineSystemPrompt'>,
  config: Pick<ProjectConfig, 'project' | 'systemPrompts'>,
): SystemPromptBlock[] {
  const blocks: SystemPromptBlock[] = []
  const includedIds = new Set<string>()

  if (config.project?.systemPrompt) {
    blocks.push({ type: 'text', text: config.project.systemPrompt })
  }

  for (const sp of config.systemPrompts ?? []) {
    if (sp.default && !includedIds.has(sp.id)) {
      blocks.push({ type: 'text', text: sp.text })
      includedIds.add(sp.id)
    }
  }

  for (const id of agentDef.systemPrompts ?? []) {
    if (includedIds.has(id)) continue
    const sp = config.systemPrompts?.find((s) => s.id === id)
    if (sp) {
      blocks.push({ type: 'text', text: sp.text })
      includedIds.add(sp.id)
    }
  }

  if (agentDef.inlineSystemPrompt) {
    blocks.push({ type: 'text', text: agentDef.inlineSystemPrompt })
  }

  return blocks
}
