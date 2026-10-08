import type { InboxItem } from '@ia-flow/shared'
import { describe, expect, it } from 'vitest'
import { buildQueue } from '@/features/inbox/queue/build'
import {
  clip,
  EPIC_CHIP_CHARS,
  epicReason,
  epicsOf,
  neckOf,
  withEpic,
} from '@/features/inbox/queue/epics'
import { item } from '@/features/inbox/test/fixtures'

const NOW = Date.parse('2026-01-02T10:00:00.000Z')

const filtros = {
  ref: 'la-haus/lh-seller-v2-frontend#4200',
  title: 'Filtros del listado',
  done: 3,
  total: 5,
}
const leads = { ref: 'la-haus/subscriptions#1100', title: 'Calidad de leads', done: 2, total: 6 }

const task = (n: number, over: Partial<InboxItem> = {}) =>
  item({ ref: `la-haus/lh-seller-v2-frontend#${n}`, title: `Tarea ${n}`, ...over })

describe('epicsOf — dónde se traba cada épica', () => {
  it('una entrada por épica, en el orden de su primera decisión, con la que la traba', () => {
    const lines = epicsOf([
      task(1170, { kind: 'doubt', actions: ['answer_and_unblock'], epic: leads }),
      task(4281, { epic: filtros }),
      task(1192, { kind: 'prd', actions: ['approve_prd'], epic: leads }),
    ])
    expect(lines.map((l) => l.title)).toEqual(['Calidad de leads', 'Filtros del listado'])
    expect(lines[0]).toMatchObject({
      ref: 'la-haus/subscriptions#1100',
      url: 'https://github.com/la-haus/subscriptions/issues/1100',
      done: 2,
      total: 6,
      pct: 33,
      neck: '#1170 espera tu respuesta',
      blockedAt: 'la-haus/lh-seller-v2-frontend#1170',
    })
    expect(lines[1]).toMatchObject({ pct: 60, neck: '#4281 espera tu merge' })
  })

  it('sólo cuentan las decisiones (need + fail): lo que corre o espera turno no traba en vos', () => {
    const lines = epicsOf([
      task(1, { group: 'run', kind: 'agent', epic: filtros }),
      task(2, { group: 'queue', kind: 'turn', epic: leads }),
      task(3, { group: 'fail', kind: 'crash', actions: ['retry'], epic: leads }),
    ])
    expect(lines.map((l) => l.neck)).toEqual(['#3 espera tu reintento'])
  })

  it('sin épicas no hay entradas; una épica sin sub-issues no divide por cero', () => {
    expect(epicsOf([task(1), task(2)])).toEqual([])
    expect(epicsOf([task(1, { epic: { ...filtros, done: 0, total: 0 } })])[0]?.pct).toBe(0)
  })

  it('un ref de épica sin forma owner/repo#n no tiene link', () => {
    expect(epicsOf([task(1, { epic: { ...filtros, ref: 'raro' } })])[0]).not.toHaveProperty('url')
  })

  it('el verbo de lo que espera sale del tipo de decisión', () => {
    expect(neckOf({ ref: 'a/b#9', kind: 'prd', group: 'need' })).toBe(
      '#9 espera tu aprobación del PRD',
    )
    expect(neckOf({ ref: 'a/b#9', kind: 'merge', group: 'need' })).toBe('#9 espera tu merge')
  })
})

describe('el chip de la épica', () => {
  it('va al final y sólo si queda lugar', () => {
    const chip = epicReason(filtros)
    expect(chip).toEqual({
      text: 'épica Filtros del listado 3/5',
      full: 'épica Filtros del listado 3/5',
    })
    expect(withEpic([{ text: 'a' }], [filtros], 2)).toEqual([{ text: 'a' }, chip])
    expect(withEpic([{ text: 'a' }, { text: 'b' }], [filtros], 2)).toEqual([
      { text: 'a' },
      { text: 'b' },
    ])
    expect(withEpic([{ text: 'a' }, { text: 'b' }, { text: 'c' }], [filtros], 2)).toHaveLength(2)
    expect(withEpic([], [undefined], 2)).toEqual([])
  })

  it('un título largo se recorta a EPIC_CHIP_CHARS con «…»; el entero va en `full`', () => {
    const long = {
      ...filtros,
      title:
        'feat(360): funnel configurable por empresa — layer con etapas personalizadas, gateado por permiso IMS',
      done: 18,
      total: 24,
    }
    const chip = epicReason(long)
    expect(chip.text).toBe('épica feat(360): funnel configurable… 18/24')
    expect(chip.text.length).toBeLessThanOrEqual('épica  18/24'.length + EPIC_CHIP_CHARS)
    expect(chip.full).toBe(`épica ${long.title} 18/24`)
    expect(clip('  a   b  ', 10)).toBe('a b')
  })

  it('en la cola: 3 chips en «Lo primero» y 2 en «Después», la épica sólo con lugar', () => {
    const q = buildQueue({
      now: NOW,
      items: [
        task(1, { chips: [{ text: 'a' }, { text: 'b' }], epic: filtros }),
        task(2, {
          kind: 'doubt',
          actions: ['answer_and_unblock'],
          chips: [{ text: 'x' }],
          epic: leads,
        }),
        task(3, {
          kind: 'doubt',
          actions: ['answer_and_unblock'],
          chips: [{ text: 'x' }, { text: 'y' }],
          epic: leads,
        }),
      ],
    })
    expect(q.first?.reasons.map((r) => r.text)).toEqual(['a', 'b', 'épica Filtros del listado 3/5'])
    expect(q.rest[0]?.reasons.map((r) => r.text)).toEqual(['x', 'épica Calidad de leads 2/6'])
    expect(q.rest[1]?.reasons.map((r) => r.text)).toEqual(['x', 'y'])
  })

  it('la cola trae las épicas de sus decisiones; sin épicas, la lista vacía', () => {
    const q = buildQueue({ now: NOW, items: [task(1, { epic: filtros })] })
    expect(q.epics.map((e) => e.title)).toEqual(['Filtros del listado'])
    expect(buildQueue({ now: NOW, items: [task(1)] }).epics).toEqual([])
  })
})
