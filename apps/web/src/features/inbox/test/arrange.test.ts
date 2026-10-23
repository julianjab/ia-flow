import type { InboxItem } from '@ia-flow/shared'
import { describe, expect, it } from 'vitest'
import { arrange, fingerprintOf, snoozeOf, stillSnoozed } from '@/features/inbox/queue/arrange'
import { execution, item } from '@/features/inbox/test/fixtures'

const NOW = Date.parse('2026-01-05T10:00:00.000Z')

const task = (n: number, since: string, over: Partial<InboxItem> = {}) =>
  item({ ref: `acme/api#${n}`, title: `Tarea ${n}`, since, ...over })

const a = task(1, '2026-01-03T10:00:00.000Z')
const b = task(2, '2026-01-04T10:00:00.000Z')
const c = task(3, '2026-01-01T10:00:00.000Z')
const running = task(9, '2026-01-04T12:00:00.000Z', { group: 'run', execution: execution() })

const refs = (items: readonly InboxItem[]) => items.map((i) => i.ref)
const base = { pins: [], snoozes: [], now: NOW }

describe('arrange', () => {
  it('con «Prioridad» respeta el orden del runner y deja lo que corre al final', () => {
    const out = arrange({ ...base, items: [a, running, b, c], sort: 'priority' })
    expect(refs(out.items)).toEqual(['acme/api#1', 'acme/api#2', 'acme/api#3', 'acme/api#9'])
  })

  it('ordena por la fecha en que la tarea quedó así, en los dos sentidos', () => {
    expect(refs(arrange({ ...base, items: [a, b, c], sort: 'recent' }).items)).toEqual([
      'acme/api#2',
      'acme/api#1',
      'acme/api#3',
    ])
    expect(refs(arrange({ ...base, items: [a, b, c], sort: 'oldest' }).items)).toEqual([
      'acme/api#3',
      'acme/api#1',
      'acme/api#2',
    ])
  })

  it('las fijadas van primero, en el orden en que se fijaron, con cualquier orden', () => {
    const out = arrange({
      ...base,
      items: [a, b, c],
      sort: 'recent',
      pins: ['acme/api#3', 'acme/api#1'],
    })
    expect(refs(out.items)).toEqual(['acme/api#3', 'acme/api#1', 'acme/api#2'])
    expect(out.pinned).toEqual(['acme/api#3', 'acme/api#1'])
  })

  it('una fijada que dejó de necesitarte se desfija', () => {
    const out = arrange({ ...base, items: [a, b], sort: 'priority', pins: ['acme/api#3'] })
    expect(out.pinned).toEqual([])
  })

  it('una pospuesta sale de la cola y queda en `snoozed` mientras nada cambie', () => {
    const out = arrange({
      ...base,
      items: [a, b, c],
      sort: 'priority',
      snoozes: [snoozeOf(b, null)],
    })
    expect(refs(out.items)).toEqual(['acme/api#1', 'acme/api#3'])
    expect(refs(out.snoozed)).toEqual(['acme/api#2'])
  })

  it('vuelve sola cuando cambia algo de la tarea', () => {
    const moved = { ...b, status: 'Build', since: '2026-01-05T09:00:00.000Z' }
    const out = arrange({
      ...base,
      items: [a, moved],
      sort: 'priority',
      snoozes: [snoozeOf(b, null)],
    })
    expect(refs(out.items)).toEqual(['acme/api#1', 'acme/api#2'])
    expect(out.activeSnoozes).toEqual([])
  })

  it('con plazo, vuelve cuando vence aunque nada cambie', () => {
    const snooze = snoozeOf(b, NOW - 1000)
    expect(stillSnoozed(snooze, b, NOW)).toBe(false)
    expect(stillSnoozed(snoozeOf(b, NOW + 1000), b, NOW)).toBe(true)
  })

  it('una pospuesta fijada no aparece arriba: está pospuesta', () => {
    const out = arrange({
      ...base,
      items: [a, b],
      sort: 'priority',
      pins: ['acme/api#2'],
      snoozes: [snoozeOf(b, null)],
    })
    expect(refs(out.items)).toEqual(['acme/api#1'])
    expect(out.pinned).toEqual([])
  })

  it('la huella cambia con la corrida, el PR o lo que te pide', () => {
    const fp = fingerprintOf(a)
    expect(fingerprintOf({ ...a, execution: execution({ id: 'otra' }) })).not.toBe(fp)
    expect(fingerprintOf({ ...a, pr: { number: 5, url: 'x' } })).not.toBe(fp)
    expect(fingerprintOf({ ...a, kind: 'prd' })).not.toBe(fp)
    expect(fingerprintOf({ ...a, why: 'otro texto' })).toBe(fp)
  })
})
