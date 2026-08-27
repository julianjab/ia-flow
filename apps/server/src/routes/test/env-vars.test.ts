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

// La precedencia es db > env, y después de `loadIntoProcess` el proceso ya no
// puede reconstruirla mirando `Bun.env` (ahí está el valor de la DB). Estas
// son las cuatro combinaciones que la pantalla tiene que poder distinguir.
describe('resolveEnvVarValue', () => {
  test('sin valor en ningún lado no hay fuente', () => {
    expect(resolveEnvVarValue(null, undefined, false)).toEqual({
      value: null,
      source: null,
      overridesEnv: false,
    })
  })

  test('sólo en el ambiente → viene del entorno', () => {
    expect(resolveEnvVarValue(null, 'info', false)).toEqual({
      value: 'info',
      source: 'env',
      overridesEnv: false,
    })
  })

  test('guardado y sin nada en el ambiente → guardado, sin override', () => {
    // `envAfterLoad` es el MISMO valor porque `loadIntoProcess` ya lo volcó:
    // por eso el flag no se puede derivar de comparar estos dos argumentos.
    expect(resolveEnvVarValue('debug', 'debug', false)).toEqual({
      value: 'debug',
      source: 'db',
      overridesEnv: false,
    })
  })

  test('guardado sobre un valor distinto del ambiente → override', () => {
    expect(resolveEnvVarValue('debug', 'debug', true)).toEqual({
      value: 'debug',
      source: 'db',
      overridesEnv: true,
    })
  })

  test('el guardado gana aunque el ambiente traiga otra cosa', () => {
    // Defensa contra invertir la precedencia sin querer: acá el argumento del
    // ambiente difiere del guardado (un `loadIntoProcess` que todavía no
    // corrió), y el que sale tiene que seguir siendo el de la DB.
    expect(resolveEnvVarValue('debug', 'info', true).value).toBe('debug')
  })
})
