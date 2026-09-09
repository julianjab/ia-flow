import type { Migration } from './runner.js'

// Estructura únicamente — sin sembrar contenido (regla del repo). La fila
// para el caller 'task-chat' la carga un seed one-off fuera de esta
// migración (ver PR #225): sembrar prompts desde una migración pisaría lo
// que el operador edite después vía la ruta CRUD.
//
// `agent_id` es la PK: cada caller ad-hoc (un `agentId` fijo en código, no un
// AgentDefinition real) tiene a lo sumo una config. `system_prompts` es un
// array JSON de `SystemPromptRef` (ver AssistCallerConfigSchema en
// packages/shared) — mismo shape que `AgentDefinition.systemPrompts`.
const migration: Migration = {
  id: '075-assist-caller-configs',
  description:
    'assist_caller_configs table: system prompts por caller ad-hoc de AssistWithAiUseCase',
  up(db) {
    db.run(`
      CREATE TABLE IF NOT EXISTS assist_caller_configs (
        agent_id TEXT PRIMARY KEY,
        system_prompts TEXT
      )
    `)
  },
}

export default migration
