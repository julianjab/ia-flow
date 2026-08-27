import type { EnvVarState } from '@/features/env-vars/api'
import { describe, expect, it } from 'vitest'
import { buildEnvPatch } from '../patch'

function v(over: Partial<EnvVarState> = {}): EnvVarState {
  return {
    isSet: true,
    secret: false,
    value: null,
    source: 'db',
    overridesEnv: false,
    label: 'x',
    description: 'x',
    kind: 'text',
    group: 'daemon',
    groupLabel: 'Daemon',
    ...over,
  }
}

describe('buildEnvPatch', () => {
  it('NO manda una no-secreta que el operador no tocó', () => {
    // La regresión que motivó esto: el GET responde `dbVal ?? Bun.env[key]`, así
    // que `LOG_LEVEL` viene pre-cargada con lo que declaró el runner.yaml. Al
    // mandarla de vuelta quedaba persistida en la DB y a partir de ahí ganaba
    // sobre el YAML para siempre.
    const patch = buildEnvPatch(
      { LOG_LEVEL: v({ value: 'info' }) },
      { LOG_LEVEL: 'info' },
      { LOG_LEVEL: 'info' },
    )
    expect(patch).toEqual({})
  })

  it('manda sólo la no-secreta que cambió, y deja quietas a las demás', () => {
    const patch = buildEnvPatch(
      {
        LOG_LEVEL: v({ value: 'info' }),
        IA_FLOW_DAEMON_MODE: v({ value: 'webhook' }),
        IA_FLOW_GITHUB_APP_ID: v({ value: '4599112' }),
      },
      { LOG_LEVEL: 'info', IA_FLOW_DAEMON_MODE: 'polling', IA_FLOW_GITHUB_APP_ID: '4599112' },
      { LOG_LEVEL: 'info', IA_FLOW_DAEMON_MODE: 'webhook', IA_FLOW_GITHUB_APP_ID: '4599112' },
    )
    expect(patch).toEqual({ IA_FLOW_DAEMON_MODE: 'polling' })
  })

  it('manda `` cuando se vacía una no-secreta — es cómo se borra', () => {
    // El backend interpreta '' como `envRepo.delete()` + borrar de Bun.env. Si
    // la condición fuera "no vacío" en vez de "distinto del inicial", borrar
    // desde la UI dejaría de funcionar.
    const patch = buildEnvPatch(
      { IA_FLOW_GITHUB_APP_ID: v({ value: '4599112' }) },
      { IA_FLOW_GITHUB_APP_ID: '' },
      { IA_FLOW_GITHUB_APP_ID: '4599112' },
    )
    expect(patch).toEqual({ IA_FLOW_GITHUB_APP_ID: '' })
  })

  it('no manda una no-secreta que estaba vacía y sigue vacía', () => {
    const patch = buildEnvPatch({ OTEL_SDK_DISABLED: v({ isSet: false }) }, {}, {})
    expect(patch).toEqual({})
  })

  it('manda un secreto sólo si se escribió algo, y lo trimea', () => {
    const vars = { GITHUB_TOKEN: v({ secret: true, kind: 'password', group: 'github' }) }
    expect(buildEnvPatch(vars, { GITHUB_TOKEN: '  ghp_x  ' }, { GITHUB_TOKEN: '' })).toEqual({
      GITHUB_TOKEN: 'ghp_x',
    })
  })

  it('un secreto en blanco se conserva: nunca viaja como `` (no se puede borrar desde acá)', () => {
    // Su input arranca siempre vacío porque el GET no devuelve el valor, así
    // que mandar '' borraría un token que el operador nunca quiso tocar. La
    // contracara asumida: borrar un secreto requiere otro camino.
    const vars = { GITHUB_TOKEN: v({ secret: true, kind: 'password', group: 'github' }) }
    expect(buildEnvPatch(vars, { GITHUB_TOKEN: '   ' }, { GITHUB_TOKEN: '' })).toEqual({})
  })

  it('un secreto seteado en el entorno no se persiste con sólo guardar', () => {
    // Mismo caso que el de LOG_LEVEL pero del lado de los secretos: un
    // GITHUB_TOKEN que vive en el env del proceso no debe filtrarse a la DB.
    const vars = { GITHUB_TOKEN: v({ secret: true, isSet: true, kind: 'password' }) }
    expect(buildEnvPatch(vars, { GITHUB_TOKEN: '' }, { GITHUB_TOKEN: '' })).toEqual({})
  })

  it('ignora borradores de claves que el server no listó', () => {
    // `vars` es el universo: si el backend dejó de exponer una variable, un
    // borrador viejo no debe seguir viajando.
    const patch = buildEnvPatch(
      { LOG_LEVEL: v({ value: 'info' }) },
      { VIEJA: 'x', LOG_LEVEL: 'info' },
      { LOG_LEVEL: 'info' },
    )
    expect(patch).toEqual({})
  })
})
