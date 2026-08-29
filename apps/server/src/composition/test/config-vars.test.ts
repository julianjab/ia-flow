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
// Anthropic se ofrezcan — un proceso que despacha todo a agent-hosts remotos no
// las necesita.
beforeAll(() => {
  providerRegistry.register(anthropicApiProvider)
})

// `describeConfig()` de las credenciales de GitHub angosta los campos según el
// modo PEDIDO, y ese modo sale de `Bun.env` en cada llamada. Sin fijarlo, el
// test no mide "el cableado por default" sino el `.env` (o el shell) de quien
// corre la suite: una máquina con `IA_FLOW_GITHUB_AUTH_MODE=static` exportado
// —el caso real que dejó esto rojo— ve las cuatro `IA_FLOW_GITHUB_APP_*` como
// huérfanas cuando en realidad están declaradas, sólo que para otro modo.
const MODE_VAR = 'IA_FLOW_GITHUB_AUTH_MODE'

function withAuthMode<T>(mode: string | undefined, fn: () => T): T {
  const previous = Bun.env[MODE_VAR]
  if (mode === undefined) delete Bun.env[MODE_VAR]
  else Bun.env[MODE_VAR] = mode
  try {
    return fn()
  } finally {
    if (previous === undefined) delete Bun.env[MODE_VAR]
    else Bun.env[MODE_VAR] = previous
  }
}

describe('relevantConfigVars', () => {
  it('reclama TODA variable del catálogo en el cableado por default', () => {
    // Es la garantía de "que no se pierda ninguna": si agregás una entrada a
    // ENV_VAR_DEFINITIONS y ningún dueño la declara, este test la nombra.
    // Sin modo seteado el default es `auto`, que ofrece las credenciales de
    // las tres estrategias — el único modo en el que "ninguna huérfana" es la
    // afirmación correcta.
    const relevant = withAuthMode(undefined, relevantConfigVars)
    const huerfanas = Object.keys(ENV_VAR_DEFINITIONS).filter((k) => !relevant.has(k))
    expect(huerfanas).toEqual([])
  })

  it('el modo github-app reclama las cuatro variables de la App', () => {
    // El modo del daemon desatendido tiene que ser configurable desde Settings
    // y no sólo por `.env`: si su dueño no las declara, la UI no las ofrece y
    // el operador no tiene dónde pegar el App ID ni el PEM.
    const relevant = withAuthMode('github-app', relevantConfigVars)
    for (const name of [
      'IA_FLOW_GITHUB_APP_ID',
      'IA_FLOW_GITHUB_APP_PRIVATE_KEY',
      'IA_FLOW_GITHUB_APP_PRIVATE_KEY_PATH',
      'IA_FLOW_GITHUB_APP_INSTALLATION_ID',
    ]) {
      expect(relevant.has(name)).toBe(true)
    }
    // Y el selector de modo, que es lo que permite volver a cualquier otro.
    expect(relevant.has(MODE_VAR)).toBe(true)
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
