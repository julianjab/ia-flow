import type { Migration } from './runner.js'

// Estructura únicamente — sin sembrar contenido acá (regla del repo). La
// fila para el caller 'task-chat' se siembra en 076-seed-task-chat-assist-
// config.ts, la migración siguiente — excepción deliberada y documentada
// ahí, no en ésta: sin esa fila la feature arranca sin ningún system
// prompt, a diferencia de config real de operador que sí competiría con un
// seed (ver el comentario de 076). `INSERT OR IGNORE` en esa migración hace
// que una fila que el operador ya editó vía la ruta CRUD nunca se pise.
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
