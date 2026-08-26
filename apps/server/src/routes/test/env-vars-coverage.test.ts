// Red de seguridad de la migración del catálogo de env vars: ninguna variable
// que hoy se puede configurar puede desaparecer de la UI.
//
// El riesgo del diseño declarativo (`describeConfig()` en cada dueño) es
// silencioso: si un módulo lee `process.env.X` y nadie lo declara, la variable
// simplemente deja de ofrecerse y el operador no puede setearla. No falla
// nada, no hay error — sólo un knob que ya no existe.
//
// Este test fija la lista completa por nombre. Sacar una variable exige
// borrarla acá a mano, que es justo la fricción que queremos.
import { describe, expect, it } from 'bun:test'
import { ENV_VAR_DEFINITIONS } from '../env-vars.js'

/** Las 21 configurables al momento de introducir ConfigVarDef. */
const BASELINE = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'IA_FLOW_GITHUB_AUTH_MODE',
  'GITHUB_TOKEN',
  'IA_FLOW_GITHUB_APP_ID',
  'IA_FLOW_GITHUB_APP_PRIVATE_KEY',
  'IA_FLOW_GITHUB_APP_PRIVATE_KEY_PATH',
  'IA_FLOW_GITHUB_APP_INSTALLATION_ID',
  'SLACK_BOT_TOKEN',
  'IA_FLOW_DAEMON_MODE',
  'IA_FLOW_WEBHOOK_SECRET',
  'IA_FLOW_WEBHOOK_FALLBACK_MS',
  'IA_FLOW_POLL_INTERVAL_MS',
  'IA_FLOW_STARTUP_SCAN',
  'IA_FLOW_CRASH_RECOVERY',
  'IA_FLOW_REMOTE_HEALTH_INTERVAL_MS',
  'IA_FLOW_REMOTE_HEALTH_TIMEOUT_MS',
  'LOG_LEVEL',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_SDK_DISABLED',
] as const

describe('catálogo de env vars', () => {
  it('no pierde ninguna variable configurable', () => {
    const catalogo = new Set(Object.keys(ENV_VAR_DEFINITIONS))
    const faltantes = BASELINE.filter((name) => !catalogo.has(name))
    expect(faltantes).toEqual([])
  })

  it('las tres de OTel siguen ahí — la telemetría no es opcional en ningún build', () => {
    for (const name of [
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      'OTEL_EXPORTER_OTLP_HEADERS',
      'OTEL_SDK_DISABLED',
    ]) {
      expect(Object.keys(ENV_VAR_DEFINITIONS)).toContain(name)
    }
  })

  it('toda variable del catálogo se describe y se agrupa', () => {
    // Una entrada sin descripción es un campo que el operador no sabe para qué
    // sirve; sin grupo, uno que la UI no sabe dónde poner.
    for (const [name, def] of Object.entries(ENV_VAR_DEFINITIONS)) {
      expect(def.label, `${name} sin label`).toBeTruthy()
      expect(def.description, `${name} sin description`).toBeTruthy()
      expect(def.group, `${name} sin group`).toBeTruthy()
    }
  })

  it('toda variable marcada `select` ofrece opciones', () => {
    for (const [name, def] of Object.entries(ENV_VAR_DEFINITIONS)) {
      if (def.kind !== 'select') continue
      expect(
        (def as { options?: string[] }).options?.length,
        `${name} select sin options`,
      ).toBeGreaterThan(0)
    }
  })

  it('los secretos nunca son `select` — no se eligen de una lista', () => {
    for (const [name, def] of Object.entries(ENV_VAR_DEFINITIONS)) {
      if (!def.secret) continue
      expect(def.kind, `${name} es secreto y select`).not.toBe('select')
    }
  })
})
