import baseAgentsYamlText from './base-agents.yaml' with { type: 'text' }
import { loadBaseAgentsFromText } from './loader.js'

/**
 * Scope fijo del asistente conversacional — NO es el id de un `Project` real
 * (a pedido explícito: el asistente no aparece en `GET /api/projects` ni en
 * ninguna pantalla de proyectos). Es sólo la clave que usan
 * `configRepo.getConfig`/`ruleRepo.visibleTo` (`SystemAgentProjectConfigRepository`/
 * `SystemRuleRepository`) para saber cuándo inyectar `base-agents.yaml`, y
 * la que `composition/actions.ts::managerFor` reconoce para devolver
 * `chatIssueManager` a mano — nunca sale de `buildManagers()`/
 * `projectRepo.list()` como el resto de los proyectos.
 */
export const CHAT_PROJECT_ID = '__chat__'

export const CHAT_ASSISTANT_AGENT_ID = 'chat-assistant'

/** Agentes/reglas intrínsecos del engine, ya parseados — el texto se embebe
 *  en el bundle en build time (ver `yaml-text.d.ts`), así que esto no
 *  depende de que el YAML exista en disco en runtime. */
export const baseAgents = loadBaseAgentsFromText(baseAgentsYamlText)

export { type BaseAgentsConfig, loadBaseAgents, loadBaseAgentsFromText } from './loader.js'
export { SystemAgentProjectConfigRepository } from './SystemAgentProjectConfigRepository.js'
export { SystemRuleRepository } from './SystemRuleRepository.js'
