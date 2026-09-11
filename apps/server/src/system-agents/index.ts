/** Id fijo del proyecto reservado que hospeda las sesiones de chat — sólo
 *  plumbing (le da un id a `configRepo.getConfig`/`ruleRepo.visibleTo`), no
 *  aporta prompt ni tools: eso vive en `base-agents.yaml`. */
export const CHAT_PROJECT_ID = '__chat__'

export const CHAT_ASSISTANT_AGENT_ID = 'chat-assistant'

export { type BaseAgentsConfig, loadBaseAgents } from './loader.js'
export { SystemAgentProjectConfigRepository } from './SystemAgentProjectConfigRepository.js'
export { SystemRuleRepository } from './SystemRuleRepository.js'
