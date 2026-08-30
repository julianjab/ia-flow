import { describe, expect, test } from 'bun:test'
import { ISSUE_CREATED, ISSUE_STATUS_CHANGED, SCHEDULE_TICK } from '@ia-flow/rules'
import {
  EVENT_CATALOG,
  ISSUE_SCANNED,
  RUN_FINISHED,
  TASK_MESSAGE_EVENT,
  WAIT_EXPIRED,
  WAIT_RESUMED,
  describeEventType,
} from '@ia-flow/shared'
import {
  CI_FINISHED,
  PR_CLOSED,
  PR_MERGED,
  PR_OPENED,
  PR_READY,
  PR_REVIEW_SUBMITTED,
  PR_SYNCHRONIZED,
} from '../adapters/github/webhook-events.js'
import { SLACK_MESSAGE } from '../adapters/slack/webhook-events.js'

// El guard de deriva del catálogo.
//
// Vive acá y no en `packages/shared` porque es el único lugar del monorepo que
// ve las TRES fuentes de constantes a la vez: shared, rules y los adapters. Un
// test en shared sólo podría comprobar las suyas, que es justo la parte que no
// se olvida.
//
// Lo que previene: alguien agrega un tipo de evento nuevo en un normalizador,
// el engine lo publica bien, las reglas lo matchean bien — y el autocomplete
// nunca lo ofrece, así que nadie sabe que existe.

/** Todas las constantes de tipo de evento que el proceso declara hoy. */
const DECLARED: Record<string, string> = {
  ISSUE_SCANNED,
  ISSUE_STATUS_CHANGED,
  ISSUE_CREATED,
  PR_OPENED,
  PR_SYNCHRONIZED,
  PR_READY,
  PR_MERGED,
  PR_CLOSED,
  PR_REVIEW_SUBMITTED,
  CI_FINISHED,
  SLACK_MESSAGE,
  TASK_MESSAGE_EVENT,
  WAIT_EXPIRED,
  WAIT_RESUMED,
  RUN_FINISHED,
  SCHEDULE_TICK,
}

describe('EVENT_CATALOG — deriva', () => {
  test('cubre TODA constante de tipo de evento declarada en el proceso', () => {
    const faltan = Object.entries(DECLARED)
      .filter(([, type]) => !describeEventType(type))
      .map(([name, type]) => `${name} (${type})`)

    expect(faltan).toEqual([])
  })

  // Al revés: un tipo en el catálogo que ningún productor emite le ofrecería al
  // operador un evento que nunca va a llegar.
  test('no inventa tipos que nadie emite', () => {
    const emitidos = new Set(Object.values(DECLARED))
    const sobran = EVENT_CATALOG.filter((e) => !emitidos.has(e.type)).map((e) => e.type)

    expect(sobran).toEqual([])
  })

  test('cada entrada dice algo útil', () => {
    for (const e of EVENT_CATALOG) {
      expect(e.description.length).toBeGreaterThan(15)
      // Sin campos, el autocomplete de condiciones queda mudo para ese evento.
      expect(e.fields.length).toBeGreaterThan(0)
    }
  })

  test('no hay tipos duplicados', () => {
    const tipos = EVENT_CATALOG.map((e) => e.type)
    expect(new Set(tipos).size).toBe(tipos.length)
  })

  // `issue.scanned` es el único que se re-emite solo, y de eso depende el aviso
  // de regla recurrente del editor.
  test('marca como recurrente exactamente al que lo es', () => {
    const recurrentes = EVENT_CATALOG.filter((e) => e.recurring).map((e) => e.type)
    expect(recurrentes).toEqual([ISSUE_SCANNED])
  })
})
