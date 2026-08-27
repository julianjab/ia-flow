import { describe, expect, test } from 'bun:test'
import { crossedQuotaFloor } from '../client.js'

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
