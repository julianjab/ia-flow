// @ia-flow/rules — el motor de reglas y las primitivas puras del engine.
//
// Sin I/O, sin estado, sin dependencias más allá de `@ia-flow/shared`. Sus
// consumidores (la selección de agentes en `agent-engine`, el filtro de
// proyectos en `issue-sources`, y el motor de reglas) no se conocen entre sí,
// que es la razón de que esto sea un paquete y no un rincón de alguno de ellos.
export {
  clearActionRegistry,
  getActionHandler,
  registerAction,
  registeredActionKinds,
  validateActions,
} from './actions.js'
export type {
  ActionContext,
  ActionHandler,
  ActionResult,
  ActionValidationError,
} from './actions.js'
export { renderBrief } from './brief.js'
export { aggregateOutcomes, InMemoryEventBus } from './bus.js'
export type { EventBusOptions, EventHandler, EventOutcome, IEventBus } from './bus.js'
export { matchRules, summarizeRuleRejections } from './match.js'
export type { RejectedRule, RuleMatchInput, RuleMatchResult, RuleRejectionReason } from './match.js'
export { RuleEngineHandler } from './rule-engine-handler.js'
export { IntervalEventProducer } from './producer.js'
export type { Disposable, EventNormalizer, EventProducer, Publish } from './producer.js'
export { matchesCron, parseCron, SCHEDULE_TICK, scheduleTickEvent } from './schedule.js'
export type { CronSpec } from './schedule.js'
export { diffStatus, ISSUE_CREATED, ISSUE_STATUS_CHANGED } from './status-diff.js'
export type { DiffInput, DiffItem } from './status-diff.js'
export type { RuleEngineDeps } from './rule-engine-handler.js'
export { runRule } from './runner.js'
export type { ActionRunRecorder, RunRuleDeps } from './runner.js'
export { matchScope } from './scope.js'
export type { MatchableScope, ScopeLocation } from './scope.js'
export { WaitHandler } from './wait-handler.js'
export type { WaitHandlerDeps } from './wait-handler.js'
export { expiredWaits, isPause, matchesWait, matchWaits } from './waits.js'
export { condToOp, evalWhen } from './when.js'
