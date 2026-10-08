import { describe, expect, it } from 'vitest'
import { ageOf } from '@/features/inbox/queue/age'
import { buildQueue } from '@/features/inbox/queue/build'
import { countWord, groupSummary, oldestAge } from '@/features/inbox/queue/groupTitle'
import { item } from '@/features/inbox/test/fixtures'

const NOW = Date.parse('2026-01-03T10:00:00.000Z')

const prd = (n: number, over = {}) =>
  item({
    ref: `acme/api#${n}`,
    title: `PRD largo número ${n} con un título que ocupa media pantalla`,
    kind: 'prd',
    status: 'Refined',
    labels: [],
    actions: ['approve_prd'],
    ...over,
  })
const merge = (n: number, over = {}) =>
  item({ ref: `acme/api#${n}`, title: `PR ${n}`, kind: 'merge', labels: ['reviewed'], ...over })

describe('groupSummary — la línea corta de una fila agrupada', () => {
  it('PRDs en la misma columna y sin bloqueos', () => {
    expect(groupSummary('prd', [prd(1), prd(2)])).toBe('Los dos están en Refined y sin bloqueos')
  })

  it('no afirma una columna que no comparten, y cuenta los bloqueados', () => {
    expect(
      groupSummary('prd', [
        prd(1),
        prd(2, { status: 'Refine', blocked_by: ['acme/api#9'] }),
        prd(3),
      ]),
    ).toBe('Los tres esperan tu aprobación · 1 con bloqueos')
  })

  it('merges: la aprobación del reviewer sale del label, no se supone', () => {
    expect(groupSummary('merge', [merge(1), merge(2)])).toBe(
      'Los dos tienen la aprobación del reviewer y sin bloqueos',
    )
    expect(groupSummary('merge', [merge(1), merge(2, { labels: [] })])).toBe(
      'Los dos esperan tu merge y sin bloqueos',
    )
  })

  it('countWord: en palabras hasta diez, después la cifra', () => {
    expect([2, 3, 10, 11].map(countWord)).toEqual(['dos', 'tres', 'diez', '11'])
  })
})

describe('oldestAge — la antigüedad de un grupo', () => {
  it('la de la hija más vieja; una fecha que no parsea no compite', () => {
    const ages = [
      ageOf('2026-01-02T10:00:00.000Z', NOW),
      ageOf('{', NOW),
      ageOf('2025-12-30T10:00:00.000Z', NOW),
    ]
    expect(oldestAge(ages)).toMatchObject({ text: '4 d', iso: '2025-12-30T10:00:00.000Z' })
  })

  it('sin ninguna fecha válida, sin antigüedad', () => {
    expect(oldestAge([ageOf('{', NOW)]).text).toBe('')
  })
})

describe('la fila agrupada en la cola', () => {
  it('el título es el resumen (no los títulos pegados) y la antigüedad, la de la más vieja', () => {
    const q = buildQueue({
      now: NOW,
      items: [
        merge(9),
        prd(1, { since: '2026-01-02T10:00:00.000Z' }),
        prd(2, { since: '2025-12-31T10:00:00.000Z' }),
      ],
    })
    const [row] = q.rest
    expect(row?.kind).toBe('group')
    expect(row?.title).toBe('Los dos están en Refined y sin bloqueos')
    expect(row?.title).not.toContain('PRD largo')
    expect(row?.age.text).toBe('3 d')
    // Los títulos completos siguen en las hijas (el detalle desplegado).
    expect(row?.kind === 'group' && row.children.map((c) => c.title)).toEqual([
      prd(1).title,
      prd(2).title,
    ])
  })
})
