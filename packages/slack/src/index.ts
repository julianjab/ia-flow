// @ia-flow/slack — todo lo que este sistema sabe de Slack, en un solo lugar.
//
// La superficie está ordenada por quién la consume: el host monta la
// integración (`installSlack`), sus rutas usan el cliente y el borde del
// webhook, y los tests usan las piezas puras.
export { installSlack, installSlackTools, SlackIntegration } from './install.js'
export type { SlackIntegrationDeps, SlackRuntime } from './install.js'

export {
  isSlackEnabled,
  isSlackWebhookEnabled,
  slackBotToken,
  slackSigningSecret,
  slackDisabledReason,
  slackWebhookDisabledReason,
  slackStatus,
} from './enabled.js'
export type { SlackStatus } from './enabled.js'

// El borde HTTP entrante: lo que la ruta del server necesita para creerle a un
// delivery y traducirlo (ver el encabezado de webhook.ts).
export {
  SLACK_MESSAGE,
  SlackWebhookTranslator,
  slackMessageEvent,
  urlVerification,
  verifySlackSignature,
} from './webhook.js'
export type { SlackWebhookDelivery } from './webhook.js'

// El cliente Web API — lo usan las rutas de `/api/slack`, que son un pasamanos
// con validación de query.
export {
  chatGetPermalink,
  conversationsHistory,
  conversationsList,
  conversationsReplies,
  getUserName,
  postMessage,
  usersList,
} from './client.js'
export type { SlackMessage, SlackUser } from './client.js'
export { parseSlackPermalink } from './permalink.js'
export type { ParsedPermalink } from './permalink.js'

export { SlackDirectory } from './directory.js'
export type { SlackChannelRef } from './directory.js'

export { RequestSlackReviewUseCase, SlackReviewError } from './review/RequestSlackReviewUseCase.js'
export type {
  IProjectLookup,
  RequestSlackReviewInput,
  RequestSlackReviewResult,
  SlackPostPort,
} from './review/RequestSlackReviewUseCase.js'

export { SLACK_TOOL_NAMES, registerSlackTools } from './tools.js'
export { SLACK_REVIEW_TOOL, registerSlackReviewTool, setSlackReviewPort } from './review-tool.js'
export type { SlackReviewPort } from './review-tool.js'

export { setLoggerFactory } from './logger.js'
export type { Logger, LoggerFactory } from './logger.js'
