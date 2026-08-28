import { describe, expect, test } from 'bun:test'
import { GitHubGraphQLError, crossedQuotaFloor, isNodeNotFoundError } from '../client.js'

// `crossedQuotaFloor` lleva estado por recurso a nivel de módulo (es lo que le
// permite responder por la transición y no por el nivel). No hay reset, así
// que cada test usa un recurso propio y una secuencia completa; 'graphql' y
// 'rest' son los dos únicos que existen, y alcanzan.
function headers(remaining: number | string, limit: number | string): Headers {
  return new Headers({
    'x-ratelimit-remaining': String(remaining),
    'x-ratelimit-limit': String(limit),
  })
}

describe('crossedQuotaFloor', () => {
  test('avisa una sola vez al cruzar, no en cada request de la ventana baja', () => {
    // Arriba del piso (10% de 5000 = 500): nada que decir.
    expect(crossedQuotaFloor('graphql', headers(5000, 5000))).toBe(false)
    expect(crossedQuotaFloor('graphql', headers(600, 5000))).toBe(false)

    // Cruza.
    expect(crossedQuotaFloor('graphql', headers(500, 5000))).toBe(true)

    // Sigue abajo, y bajando: ni una línea más. Esto es lo que evita que el
    // aviso se convierta en spam justo cuando la cuota está por agotarse.
    expect(crossedQuotaFloor('graphql', headers(499, 5000))).toBe(false)
    expect(crossedQuotaFloor('graphql', headers(1, 5000))).toBe(false)

    // La ventana se renueva → se rearma solo, sin que nadie lo resetee.
    expect(crossedQuotaFloor('graphql', headers(5000, 5000))).toBe(false)
    expect(crossedQuotaFloor('graphql', headers(10, 5000))).toBe(true)
  })

  test('sin headers de cuota usables no inventa un cruce', () => {
    // Un endpoint que no manda los headers, o los manda vacíos: `Number('')`
    // es 0, que leído literal parecería "cuota agotada" y mandaría a `info`
    // todos los requests de ese recurso.
    expect(crossedQuotaFloor('rest', new Headers())).toBe(false)
    expect(crossedQuotaFloor('rest', headers('', ''))).toBe(false)
    expect(crossedQuotaFloor('rest', headers('nope', 'nope'))).toBe(false)
    // Un limit en 0 tampoco define un piso.
    expect(crossedQuotaFloor('rest', headers(0, 0))).toBe(false)
  })
})

describe('isNodeNotFoundError', () => {
  // El caso real: un ProjectV2Item borrado del board. GitHub no responde
  // `data.node = null` — responde 200 con un error top-level, así que sin
  // esta traducción el `Promise<T | null>` de getItemById lanzaba.
  const notFound = new GitHubGraphQLError('GitHub GraphQL errors: ...', [
    {
      type: 'NOT_FOUND',
      message: "Could not resolve to a node with the global id of 'PVTI_x'.",
      path: ['node'],
    },
  ])

  test('reconoce el NOT_FOUND de un node id que ya no existe', () => {
    expect(isNodeNotFoundError(notFound)).toBe(true)
  })

  test('reconoce el mensaje aunque no venga el type', () => {
    expect(
      isNodeNotFoundError(
        new GitHubGraphQLError('x', [
          { message: "Could not resolve to a Repository with the name 'acme/nope'." },
        ]),
      ),
    ).toBe(true)
  })

  test('un error mezclado NO es "no existe" — ahí la respuesta correcta es "no sé"', () => {
    // Traducir esto a `null` haría que un problema de permisos se lea como
    // "la task se borró", que es justo la confusión que el reconciler no
    // puede permitirse.
    expect(
      isNodeNotFoundError(
        new GitHubGraphQLError('x', [
          { type: 'NOT_FOUND', message: 'Could not resolve to a node ...' },
          { type: 'FORBIDDEN', message: 'Resource not accessible by integration' },
        ]),
      ),
    ).toBe(false)
  })

  test('no confunde otros errores ni excepciones ajenas', () => {
    expect(isNodeNotFoundError(new GitHubGraphQLError('x', []))).toBe(false)
    expect(
      isNodeNotFoundError(new GitHubGraphQLError('x', [{ message: 'Something went wrong' }])),
    ).toBe(false)
    expect(isNodeNotFoundError(new Error('Could not resolve to a node'))).toBe(false)
    expect(isNodeNotFoundError(undefined)).toBe(false)
  })
})
