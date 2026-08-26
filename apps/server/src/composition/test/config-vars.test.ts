import { beforeAll, describe, expect, it } from 'bun:test'
import { ENV_VAR_DEFINITIONS } from '../../routes/env-vars.js'
import { relevantConfigVars } from '../config-vars.js'
import { anthropicApiProvider, providerRegistry } from '../container.js'

// La red del diseño declarativo. Su riesgo es silencioso: si nadie declara una
// variable, deja de ofrecerse en la UI y el operador no puede setearla — sin
// error, sin log, sin nada. Sólo un campo que ya no está.

// Quien registra los providers es el FLAVOR, no el container: importar el
// composition root deja el registry vacío. Se reproduce acá el cableado que
// hacen los dos flavors, porque de eso depende que las credenciales de
// Anthropic se ofrezcan — un proceso que despacha todo a gateways remotos no
// las necesita.
beforeAll(() => {
  providerRegistry.register(anthropicApiProvider)
})

describe('relevantConfigVars', () => {
  it('reclama TODA variable del catálogo en el cableado por default', () => {
    // Es la garantía de "que no se pierda ninguna": si agregás una entrada a
    // ENV_VAR_DEFINITIONS y ningún dueño la declara, este test la nombra.
    const relevant = relevantConfigVars()
    const huerfanas = Object.keys(ENV_VAR_DEFINITIONS).filter((k) => !relevant.has(k))
    expect(huerfanas).toEqual([])
  })

  it('las tres de OTel siempre están — la telemetría no es opcional', () => {
    const relevant = relevantConfigVars()
    for (const name of [
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      'OTEL_EXPORTER_OTLP_HEADERS',
      'OTEL_SDK_DISABLED',
    ]) {
      expect(relevant.has(name)).toBe(true)
    }
  })

  it('LOG_LEVEL siempre está — cualquier proceso loguea', () => {
    expect(relevantConfigVars().has('LOG_LEVEL')).toBe(true)
  })
})
