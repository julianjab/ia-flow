import { describe, expect, test } from 'bun:test'
import { ENV_VAR_DEFINITIONS, GROUP_LABELS, resolveEnvVarValue } from '../env-vars.js'

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

// La precedencia es env > db, y después de `loadIntoProcess` el proceso no
// puede reconstruirla mirando `Bun.env` solo. Estas son las combinaciones que
// la pantalla tiene que poder distinguir.
describe('resolveEnvVarValue', () => {
  test('sin valor en ningún lado no hay fuente', () => {
    expect(resolveEnvVarValue(null, undefined, false)).toEqual({
      value: null,
      source: null,
      savedButUnused: false,
    })
  })

  test('sólo en el ambiente → viene del entorno', () => {
    expect(resolveEnvVarValue(null, 'info', false)).toEqual({
      value: 'info',
      source: 'env',
      savedButUnused: false,
    })
  })

  test('guardado y en uso → `db`', () => {
    // `envValue` es el mismo valor porque `loadIntoProcess` lo rellenó: no hay
    // nada del ambiente que lo tape.
    expect(resolveEnvVarValue('debug', 'debug', false)).toEqual({
      value: 'debug',
      source: 'db',
      savedButUnused: false,
    })
  })

  test('el ambiente tapa lo guardado → gana el ambiente y se avisa', () => {
    expect(resolveEnvVarValue('debug', 'info', true)).toEqual({
      value: 'info',
      source: 'env',
      savedButUnused: true,
    })
  })

  test('el ambiente gana aunque haya fila guardada', () => {
    // Defensa contra volver a invertir la precedencia sin querer: el valor que
    // sale tiene que ser el del ambiente, no el de la DB.
    expect(resolveEnvVarValue('debug', 'info', true).value).toBe('info')
  })
})
