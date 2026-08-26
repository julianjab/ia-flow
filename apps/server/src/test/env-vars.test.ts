import { describe, expect, it } from 'bun:test'
import { ENV_VAR_DEFINITIONS } from '../routes/env-vars.js'

// PUT /api/env-vars descarta en silencio toda clave que no esté en el
// catálogo (`if (!ALL_KEYS.includes(key)) continue`), así que "editable desde
// la UI" es exactamente "está acá". Ver Q6 de docs/prd/otel-logs.md.
describe('ENV_VAR_DEFINITIONS — OpenTelemetry', () => {
  it('expone las tres vars editables en el group server', () => {
    expect(ENV_VAR_DEFINITIONS.OTEL_EXPORTER_OTLP_ENDPOINT).toMatchObject({
      kind: 'text',
      group: 'server',
      secret: false,
    })
    expect(ENV_VAR_DEFINITIONS.OTEL_EXPORTER_OTLP_HEADERS).toMatchObject({
      kind: 'password',
      group: 'server',
      secret: true,
    })
    expect(ENV_VAR_DEFINITIONS.OTEL_SDK_DISABLED).toMatchObject({
      kind: 'select',
      group: 'server',
      secret: false,
      options: ['false', 'true'],
    })
  })

  it('avisa en cada description que hay que reiniciar el proceso', () => {
    for (const key of [
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      'OTEL_EXPORTER_OTLP_HEADERS',
      'OTEL_SDK_DISABLED',
    ] as const) {
      // No están en DAEMON_KEYS: un PUT no dispara reloadManagers() y el
      // LoggerProvider ya está construido. Decirlo es parte del contrato.
      expect(ENV_VAR_DEFINITIONS[key].description).toContain('reiniciar el proceso')
    }
  })

  it('no declara las cuatro vars deploy-only del ADR', () => {
    const catalog = ENV_VAR_DEFINITIONS as Record<string, unknown>
    for (const key of [
      'OTEL_SERVICE_NAME',
      'OTEL_RESOURCE_ATTRIBUTES',
      'OTEL_DEPLOYMENT_ENVIRONMENT',
      'OTEL_LOG_LEVEL',
    ]) {
      expect(catalog[key]).toBeUndefined()
    }
  })
})
