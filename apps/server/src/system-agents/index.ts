import baseAgentsYamlText from './base-agents.yaml' with { type: 'text' }
import { loadBaseAgentsFromText } from './loader.js'

/** Id fijo del proyecto reservado que hospeda las sesiones de chat — sólo
 *  plumbing (le da un id a `configRepo.getConfig`/`ruleRepo.visibleTo`), no
 *  aporta prompt ni tools: eso vive en `base-agents.yaml`. */
export const CHAT_PROJECT_ID = '__chat__'

export const CHAT_ASSISTANT_AGENT_ID = 'chat-assistant'

/** Agentes/reglas intrínsecos del engine, ya parseados — el texto se embebe
 *  en el bundle en build time (ver `yaml-text.d.ts`), así que esto no
 *  depende de que el YAML exista en disco en runtime. */
export const baseAgents = loadBaseAgentsFromText(baseAgentsYamlText)

export { type BaseAgentsConfig, loadBaseAgents, loadBaseAgentsFromText } from './loader.js'
export { SystemAgentProjectConfigRepository } from './SystemAgentProjectConfigRepository.js'
export { SystemRuleRepository } from './SystemRuleRepository.js'
