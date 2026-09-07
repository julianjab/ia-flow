import { describe, expect, test } from 'bun:test'
import type { ExecutionLog } from '@ia-flow/shared'
import {
  type DispositionFacts,
  compareWithinBucket,
  resolveDisposition,
} from './task-disposition.js'

function run(over: Partial<ExecutionLog> = {}): ExecutionLog {
  return {
    id: 'e1',
    projectId: 'p1',
    taskId: 't1',
    taskTitle: 'Agregar SID al envío de SMS',
    agentId: 'implementer',
    providerId: 'anthropic-api',
    startedAt: '2026-09-01T10:00:00.000Z',
    finishedAt: '2026-09-01T10:06:40.000Z',
    outcome: 'error',
    errorMsg: null,
    stopReason: null,
    ...over,
  } as ExecutionLog
}

function facts(over: Partial<DispositionFacts> = {}): DispositionFacts {
  return {
    taskId: 't1',
    last: null,
    attempts: 0,
    blockers: [],
    hasRetryRule: false,
    isClosed: false,
    unblocks: 0,
    ...over,
  }
}

describe('resolveDisposition — el caso que la app de hoy no distingue', () => {
  // Un run que falló CON regla de retry y uno SIN ella dicen los dos `✕ falló`.
  // Uno se arregla solo en dos minutos; el otro está muerto hasta que alguien
  // lo toque. Es toda la razón de ser de este modelo.
  test('un fallo sin regla de retry te espera, y lo dice', () => {
    const v = resolveDisposition(facts({ last: run(), attempts: 2 }))
    expect(v.disposition).toBe('waiting-on-you')
    expect(v.reason).toBe('falló 2× · no hay regla de retry')
    expect(v.verb).toEqual({ label: 'Reintentar', kind: 'run' })
  })

  test('el mismo fallo CON regla de retry avanza solo, y no ofrece verbo', () => {
    const v = resolveDisposition(facts({ last: run(), attempts: 2, hasRetryRule: true }))
    expect(v.disposition).toBe('moving')
    expect(v.reason).toBe('falló 2× · reintenta solo')
    // Si no te toca, ofrecer un botón es ruido (O2).
    expect(v.verb).toBeNull()
  })

  test('`waitingOnYouSince` es cuando quedó en tus manos, no el último evento', () => {
    // O3: son dos números distintos. Una tarea ignorada seis días tiene su
    // último evento hace seis días Y lleva seis días esperándote — pero el
    // segundo es el que hay que decir, y sale del run que nadie va a retomar.
    const v = resolveDisposition(facts({ last: run({ finishedAt: '2026-09-01T10:06:40.000Z' }) }))
    expect(v.waitingOnYouSince).toBe('2026-09-01T10:06:40.000Z')
  })
})

describe('resolveDisposition — el orden de los cortes', () => {
  test('cerrado gana a todo: una tarea en Done con un run fallido ya pasó', () => {
    const v = resolveDisposition(facts({ last: run(), isClosed: true }))
    expect(v.disposition).toBe('closed')
  })

  test('corriendo gana al bloqueo: el dispatcher ya la dejó pasar', () => {
    // Decir "bloqueada" sobre algo que está corriendo contradice a la pantalla
    // de al lado.
    const v = resolveDisposition(
      facts({ last: run({ finishedAt: null, outcome: null }), blockers: ['#1236'] }),
    )
    expect(v.disposition).toBe('moving')
    expect(v.reason).toBe('corriendo · implementer')
  })

  test('un bloqueo nombra a su bloqueante, para que la fila sea navegable', () => {
    const v = resolveDisposition(facts({ blockers: ['#1236', '#1240', '#1250'] }))
    expect(v.disposition).toBe('blocked')
    expect(v.reason).toBe('espera #1236, #1240 +1')
  })
})

describe('resolveDisposition — el PR y el CI', () => {
  test('con el CI terminado te toca a vos, y el verbo va a GitHub', () => {
    // Aprobar o mergear desde la app no existe: la fila NO ofrece un botón que
    // finja hacerlo.
    const v = resolveDisposition(
      facts({
        last: run({ outcome: 'success' }),
        openPr: { number: 1233, url: 'https://github.com/o/r/pull/1233', ci: 'success' },
        unblocks: 4,
      }),
    )
    expect(v.disposition).toBe('waiting-on-you')
    expect(v.reason).toBe('PR #1233 · CI ✓ · traba 4 tareas')
    expect(v.verb?.kind).toBe('external')
    expect(v.verb?.href).toBe('https://github.com/o/r/pull/1233')
  })

  test('con el CI corriendo NO te toca: esperar es que avance solo', () => {
    const v = resolveDisposition(
      facts({
        last: run({ outcome: 'success' }),
        openPr: { number: 1233, url: 'u', ci: 'pending' },
      }),
    )
    expect(v.disposition).toBe('moving')
  })
})

describe('resolveDisposition — lo que no se puede afirmar', () => {
  test('sin poder consultar los bloqueos NO se dice que está libre', () => {
    // `undefined` es "no sé", que no es `[]`. Una tarea ordenada como libre
    // cuando está trabada es el error que este modelo existe para evitar.
    const v = resolveDisposition(facts({ blockers: undefined }))
    expect(v.reason).toBe('sin ejecutar · bloqueos sin consultar')
  })

  test('nunca corrió y sin bloqueos: ninguna regla la tomó', () => {
    const v = resolveDisposition(facts())
    expect(v.disposition).toBe('waiting-on-you')
    expect(v.verb?.label).toBe('Elegir agente y correr')
  })

  test('un run abortado a mano manda a su pantalla, no a un botón inventado', () => {
    const v = resolveDisposition(facts({ last: run({ outcome: 'cancelled', id: 'e9' }) }))
    expect(v.disposition).toBe('waiting-on-you')
    expect(v.verb).toEqual({
      label: 'Resolver',
      kind: 'route',
      href: '/general/aborted-runs?run=e9',
      hint: '· runs abortados',
    })
  })

  test('terminó bien y nada más pendiente: cerrado', () => {
    // La dirección del error es deliberada: el riesgo de este modelo es que el
    // bucket 1 crezca hasta volver a ser una bandeja de entrada. Un cerrado de
    // más se pliega; un "te espera" de más compite con los que sí te esperan.
    expect(resolveDisposition(facts({ last: run({ outcome: 'success' }) })).disposition).toBe(
      'closed',
    )
  })
})

describe('compareWithinBucket', () => {
  const base = {
    disposition: 'waiting-on-you' as const,
    unblocks: 0,
    waitingOnYouSince: null,
    verb: null,
    at: null,
  }

  test('en "te espera" manda lo que DESBLOQUEA, no la antigüedad', () => {
    // El único criterio que mide consecuencia: un PR que traba cuatro tareas
    // vale más que un fallo aislado, aunque el fallo parezca más urgente.
    const trabaCuatro = { ...base, unblocks: 4, waitingOnYouSince: '2026-09-06T00:00:00Z' }
    const viejoSolo = { ...base, unblocks: 0, waitingOnYouSince: '2026-09-01T00:00:00Z' }
    expect(compareWithinBucket(trabaCuatro, viejoSolo)).toBeLessThan(0)
  })

  test('a igual desbloqueo, primero lo que lleva más esperando', () => {
    const viejo = { ...base, waitingOnYouSince: '2026-09-01T00:00:00Z' }
    const nuevo = { ...base, waitingOnYouSince: '2026-09-06T00:00:00Z' }
    expect(compareWithinBucket(viejo, nuevo)).toBeLessThan(0)
  })

  test('sin timestamp va último: adelantarlo sería inventar antigüedad', () => {
    const conFecha = { ...base, waitingOnYouSince: '2026-09-06T00:00:00Z' }
    const sinFecha = { ...base, waitingOnYouSince: null }
    expect(compareWithinBucket(conFecha, sinFecha)).toBeLessThan(0)
  })

  test('en "avanza solo" primero lo más viejo — es lo que puede estar colgado', () => {
    const a = { ...base, disposition: 'moving' as const, at: '2026-09-01T00:00:00Z' }
    const b = { ...base, disposition: 'moving' as const, at: '2026-09-06T00:00:00Z' }
    expect(compareWithinBucket(a, b)).toBeLessThan(0)
  })

  test('en "cerrado" primero lo más reciente', () => {
    const a = { ...base, disposition: 'closed' as const, at: '2026-09-06T00:00:00Z' }
    const b = { ...base, disposition: 'closed' as const, at: '2026-09-01T00:00:00Z' }
    expect(compareWithinBucket(a, b)).toBeLessThan(0)
  })
})
