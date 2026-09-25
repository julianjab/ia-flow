import { describe, expect, test } from 'bun:test'
import * as RulesIndex from './index.js'

describe('@ia-flow/rules index', () => {
  test('re-exports every public symbol exactly once', () => {
    const expected = [
      'clearActionRegistry',
      'getActionHandler',
      'registerAction',
      'registeredActionKinds',
      'validateActions',
      'renderBrief',
      'onMatchesEvent',
      'aggregateOutcomes',
      'InMemoryEventBus',
      'matchRules',
      'summarizeRuleRejections',
      'IntervalEventProducer',
      'RuleEngineHandler',
      'runRule',
      'matchesCron',
      'parseCron',
      'SCHEDULE_TICK',
      'scheduleTickEvent',
      'matchScope',
      'diffStatus',
      'ISSUE_CREATED',
      'ISSUE_STATUS_CHANGED',
      'WaitHandler',
      'expiredWaits',
      'isPause',
      'matchesWait',
      'matchWaits',
      'condToOp',
      'evalWhen',
      'groupWhenArray',
      'traceWhen',
    ]

    for (const symbol of expected) {
      expect(RulesIndex).toHaveProperty(symbol)
      expect((RulesIndex as Record<string, unknown>)[symbol]).toBeDefined()
    }

    // Named exports on the module object are inherently unique keys, so this
    // also guards against a duplicate `export { x } from '...'` line for the
    // same symbol silently shadowing itself (as happened with onMatchesEvent).
    expect(Object.keys(RulesIndex).sort()).toEqual([...expected].sort())
  })
})
