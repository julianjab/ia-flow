import { describe, expect, test } from 'bun:test'
import { ENV_VAR_DEFINITIONS, GROUP_LABELS } from '../env-vars.js'

// PUT /api/env-vars silently ignores keys that aren't in this catalog, so a
// var missing here is invisible *and* unsettable from the UI.
describe('ENV_VAR_DEFINITIONS — daemon vars', () => {
  test('exposes the webhook secret as a secret password field', () => {
    const def = ENV_VAR_DEFINITIONS.IA_FLOW_WEBHOOK_SECRET
    expect(def.kind).toBe('password')
    expect(def.secret).toBe(true)
    expect(def.group).toBe('daemon')
  })

  test('exposes the daemon mode as a select with both modes', () => {
    const def = ENV_VAR_DEFINITIONS.IA_FLOW_DAEMON_MODE
    expect(def.kind).toBe('select')
    expect(def.options).toEqual(['webhook', 'polling'])
  })

  test('exposes both intervals', () => {
    expect(ENV_VAR_DEFINITIONS.IA_FLOW_POLL_INTERVAL_MS.group).toBe('daemon')
    expect(ENV_VAR_DEFINITIONS.IA_FLOW_WEBHOOK_FALLBACK_MS.group).toBe('daemon')
  })

  test('every declared group has a label for the UI', () => {
    for (const def of Object.values(ENV_VAR_DEFINITIONS)) {
      expect(GROUP_LABELS[def.group]).toBeTruthy()
    }
  })
})
