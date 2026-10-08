import type { InboxItem } from '@ia-flow/shared'
import { describe, expect, it } from 'vitest'
import { ageOf } from '@/features/inbox/queue/age'
import { buildQueue, FILTER_THRESHOLD } from '@/features/inbox/queue/build'
import type { QueueEntry, QueueGroup } from '@/features/inbox/queue/entries'
import { actionOf, confirmCopy, TYPE_META, typeOf, verbOf } from '@/features/inbox/queue/kinds'
import { execution, item } from '@/features/inbox/test/fixtures'

const NOW = Date.parse('2026-01-02T10:00:00.000Z')

const merge = (n: number, over: Partial<InboxItem> = {}) =>
  item({
    ref: `la-haus/lh-seller-v2-frontend#${n}`,
    url: `https://github.com/la-haus/lh-seller-v2-frontend/issues/${n}`,
    title: `Merge ${n}`,
    pr: { number: n + 1000, url: 'https://github.com/x/pull/1' },
    ...over,
  })
const prd = (n: number) =>
  item({
    ref: `la-haus/subscriptions#${n}`,
    kind: 'prd',
    actions: ['approve_prd', 'back_to_refine'],
  })
const doubt = (n: number) =>
  item({
    ref: `acme/api#${n}`,
    kind: 'doubt',
    actions: ['answer_and_unblock'],
    agent_said: '¿+57 o error?',
    execution: execution({ status: 'done', agent_id: 'refiner' }),
  })
const crash = (n: number) =>
  item({
    ref: `acme/api#${n}`,
    group: 'fail',
    kind: 'crash',
    actions: ['retry'],
    why: 'La corrida falló',
    execution: execution({
      status: 'failed',
      failure: { by: 'runtime', message: '{"status":502}' },
    }),
  })
const running = item({
  ref: 'acme/api#90',
  group: 'run',
  kind: 'agent',
  actions: ['stop'],
  since: '2026-01-02T09:00:00.000Z',
  execution: execution({ started_at: '2026-01-02T09:48:00.000Z' }),
})
const queued = item({ ref: 'acme/api#91', group: 'queue', kind: 'turn', actions: [] })

const build = (items: InboxItem[], extra: Partial<Parameters<typeof buildQueue>[0]> = {}) =>
  buildQueue({ items, now: NOW, ...extra })

describe('buildQueue — orden y titular', () => {
  it('«Lo primero» es la primera decisión del orden que llega (need|fail), no la primera card', () => {
    const q = build([running, crash(5), merge(1), queued])
    expect(q.first?.ref).toBe('acme/api#5')
    expect(q.first?.rank).toBe(1)
    expect(q.rest.map((r) => r.rank)).toEqual([2])
  })

  it('cuenta decisiones, tareas y fallas sin duplicar (un grupo es una decisión)', () => {
    const q = build([doubt(1), merge(2), merge(3), crash(4), running])
    expect(q.headline).toEqual({ decisions: 3, tasks: 4, failed: 1 })
    expect(q.restTotal).toBe(2)
  })

  it('sin decisiones: no hay «Lo primero» y el titular queda en cero', () => {
    const q = build([running, queued])
    expect(q.first).toBeNull()
    expect(q.rest).toEqual([])
    expect(q.headline).toEqual({ decisions: 0, tasks: 0, failed: 0 })
  })

  it('numera «Después» desde 2 en orden', () => {
    const q = build([doubt(1), crash(2), prd(3), doubt(4)])
    expect(q.rest.map((r) => [r.rank, r.type])).toEqual([
      [2, 'fail'],
      [3, 'prd'],
      [4, 'answer'],
    ])
  })
})

describe('buildQueue — agrupado', () => {
  it('junta ≥2 merges en una fila con sus hijas, en el lugar de la primera', () => {
    const q = build([doubt(1), merge(2), doubt(3), merge(4)])
    const group = q.rest[0] as QueueGroup
    expect(group.kind).toBe('group')
    expect(group.verb).toBe('Mergear 2 PRs')
    expect(group.action).toEqual({ id: 'merge', label: 'Mergear los 2…', confirms: true })
    expect(group.children.map((c) => c.short)).toEqual(['seller#2', 'seller#4'])
    expect(group.children.every((c) => c.action?.label === 'Mergear…')).toBe(true)
    expect(q.rest.map((r) => r.rank)).toEqual([2, 3])
  })

  it('agrupa PRDs como «Aprobar N PRDs»; uno solo no se agrupa', () => {
    const q = build([doubt(1), prd(2), prd(3), merge(4)])
    expect(q.rest.map((r) => (r.kind === 'group' ? r.verb : r.type))).toEqual([
      'Aprobar 2 PRDs',
      'merge',
    ])
    expect((q.rest[0] as QueueGroup).action.label).toBe('Aprobar los 2…')
  })

  it('«Lo primero» no entra en un grupo', () => {
    const q = build([merge(1), merge(2)])
    expect(q.first?.ref).toContain('#1')
    expect(q.rest[0]?.kind).toBe('single')
  })

  it('sólo agrupa las que ofrecen la acción del grupo', () => {
    const q = build([doubt(1), merge(2), merge(3, { actions: [] })])
    expect(q.rest.every((r) => r.kind === 'single')).toBe(true)
  })
})

describe('buildQueue — filtro por tipo', () => {
  const many = [doubt(1), merge(2), doubt(3), crash(4), prd(5)]

  it(`aparece con más de ${FILTER_THRESHOLD} decisiones, con conteo por tipo`, () => {
    expect(build(many.slice(0, 4)).filters).toBeNull()
    const q = build(many)
    expect(q.filters?.map((f) => [f.label, f.count, f.pressed])).toEqual([
      ['Todas', 4, true],
      ['Mergear', 1, false],
      ['Aprobar PRD', 1, false],
      ['Responder', 1, false],
      ['Reintentar', 1, false],
    ])
  })

  it('filtra «Después» manteniendo los números de la cola', () => {
    const q = build(many, { filter: 'answer' })
    expect(q.rest.map((r) => r.rank)).toEqual([3])
    expect(q.restTotal).toBe(4)
    expect(q.filters?.find((f) => f.type === 'answer')?.pressed).toBe(true)
  })

  it('ignora un filtro sin filas o bajo el umbral', () => {
    expect(build(many, { filter: 'relaunch' }).filter).toBeNull()
    expect(build(many.slice(0, 3), { filter: 'answer' }).rest).toHaveLength(2)
  })
})

describe('tono, verbo y razones', () => {
  it('una falla dice a quién reintenta (Card §5): el ✕ y --danger ya dicen que falló', () => {
    expect(verbOf(crash(1))).toBe('Reintentar el implementer')
    expect(verbOf({ ...crash(2), execution: undefined })).toBe('Reintentar')
  })

  it('el tono y el glifo salen del tipo, no del grupo', () => {
    expect(typeOf({ kind: 'merge', group: 'need' })).toBe('merge')
    expect(typeOf({ kind: 'prerequisite', group: 'need' })).toBe('answer')
    expect(typeOf({ kind: 'stale', group: 'need' })).toBe('relaunch')
    expect(typeOf({ kind: 'crash', group: 'fail' })).toBe('fail')
    expect(TYPE_META.merge).toMatchObject({ glyph: '✓', tone: 'accent' })
    expect(TYPE_META.prd).toMatchObject({ glyph: '○', tone: 'info' })
    expect(TYPE_META.review).toMatchObject({ glyph: '↻', tone: 'accent' })
    expect(TYPE_META.answer).toMatchObject({ glyph: '⛔', tone: 'warn' })
    expect(TYPE_META.relaunch).toMatchObject({ glyph: '◐', tone: 'warn' })
    expect(TYPE_META.fail).toMatchObject({ glyph: '✕', tone: 'danger' })
  })

  it('el verbo del dashboard manda; sin él, uno por caso', () => {
    const q = build([merge(1), merge(2, { verb: 'Decidir el merge', actions: [] })])
    expect(q.first?.verb).toBe('Mergear el PR #1001')
    expect((q.rest[0] as QueueEntry).verb).toBe('Decidir el merge')
  })

  it('recorta las razones: 3 en «Lo primero», 2 en la cola', () => {
    const chips = ['a', 'b', 'c', 'd'].map((text) => ({ text }))
    const q = build([merge(1, { chips }), doubt(2), merge(3, { chips, actions: [] })])
    expect(q.first?.reasons.map((r) => r.text)).toEqual(['a', 'b', 'c'])
    expect(q.rest[1]?.reasons.map((r) => r.text)).toEqual(['a', 'b'])
  })

  it('sin chips (runner viejo) deduce razones de la tarea', () => {
    const q = build([crash(1), merge(2, { unlocks: 2 })])
    expect(q.first?.reasons).toEqual([{ text: 'falló el runner, no el agente', tone: 'bad' }])
    expect(q.rest[0]?.reasons).toEqual([{ text: 'destraba 2', tone: 'hot' }])
  })
})

describe('buildQueue — runner viejo (/api/inbox con priority y reasons)', () => {
  it('sin chips del dashboard, las reasons del runner son los chips, en su orden y con su tono', () => {
    const q = build([
      crash(1),
      merge(2, { priority: 2, reasons: ['a un merge de Done', 'destraba 2 tareas', 'otra'] }),
    ])
    expect((q.rest[0] as QueueEntry).reasons).toEqual([
      { text: 'a un merge de Done', tone: 'hot' },
      { text: 'destraba 2 tareas', tone: 'hot' },
    ])
  })

  it('los chips del dashboard mandan sobre las reasons del runner', () => {
    const q = build([merge(1, { chips: [{ text: 'chip' }], reasons: ['razón'] })])
    expect(q.first?.reasons.map((r) => r.text)).toEqual(['chip'])
  })

  it('una falla del runner es bad y la del agente warn', () => {
    const q = build([
      { ...crash(1), reasons: ['falló el runner, no el agente'] },
      { ...crash(2), reasons: ['falló el agente'] },
    ])
    expect(q.first?.reasons).toEqual([{ text: 'falló el runner, no el agente', tone: 'bad' }])
    expect((q.rest[0] as QueueEntry).reasons).toEqual([{ text: 'falló el agente', tone: 'warn' }])
  })

  it('respeta el orden recibido (el de priority), sin reordenar por grupo ni antigüedad', () => {
    const q = build([
      merge(5, { priority: 1, since: '2026-01-02T09:00:00.000Z' }),
      { ...crash(6), priority: 2, since: '2026-01-01T00:00:00.000Z' },
      { ...doubt(7), priority: 3 },
    ])
    expect(q.first?.ref).toBe('la-haus/lh-seller-v2-frontend#5')
    expect(q.rest.map((r) => (r as QueueEntry).ref)).toEqual(['acme/api#6', 'acme/api#7'])
  })
})

describe('antigüedad', () => {
  it('corta, y vieja desde las 24 h', () => {
    expect(ageOf('2026-01-02T09:59:40.000Z', NOW)).toMatchObject({ text: 'ahora', old: false })
    expect(ageOf('2026-01-02T09:48:00.000Z', NOW)).toMatchObject({ text: '12 min', old: false })
    expect(ageOf('2026-01-01T10:00:01.000Z', NOW)).toMatchObject({ text: '23 h', old: false })
    expect(ageOf('2026-01-01T10:00:00.000Z', NOW)).toMatchObject({ text: '1 d', old: true })
    expect(ageOf('nunca', NOW)).toMatchObject({ text: '', old: false })
  })

  it('va en todas las filas, también en los grupos (la de la más vieja)', () => {
    const q = build([
      doubt(1),
      merge(2, { since: '2026-01-02T08:00:00.000Z' }),
      merge(3, { since: '2025-12-30T10:00:00.000Z' }),
    ])
    expect(q.first?.age.text).toBe('1 d')
    expect(q.rest[0]?.age).toMatchObject({ text: '3 d', old: true })
  })
})

describe('acciones y confirmación en línea', () => {
  it('merge, approve_prd, stop y las que traen confirm piden confirmación («…»)', () => {
    expect(actionOf('merge')).toEqual({ id: 'merge', label: 'Mergear…', confirms: true })
    expect(actionOf('approve_prd').label).toBe('Aprobar…')
    expect(actionOf('relaunch')).toEqual({ id: 'relaunch', label: 'Relanzar', confirms: false })
    expect(actionOf('answer_and_unblock')).toMatchObject({ confirms: false, comment: 'required' })
    expect(actionOf('deploy', [{ id: 'deploy', label: 'Desplegar', confirm: '¿Seguro?' }])).toEqual(
      {
        id: 'deploy',
        label: 'Desplegar…',
        confirms: true,
      },
    )
  })

  it('la confirmación dice qué se firma, dónde y con qué usuario', () => {
    const one = confirmCopy(actionOf('merge'), [merge(4281)], 'julian')
    expect(one.text).toBe(
      'Se mergea el PR #5281 de seller#4281 con tu usuario de GitHub (@julian).',
    )
    expect(one.label).toBe('Mergear ahora')
    const two = confirmCopy({ id: 'merge', label: 'Mergear los 2…', confirms: true }, [
      merge(1),
      merge(2),
    ])
    expect(two).toEqual({
      text: 'Se mergean los PRs de seller#1 y seller#2 con tu usuario de GitHub.',
      label: 'Mergear los 2 ahora',
    })
    expect(confirmCopy(actionOf('approve_prd'), [prd(9)]).label).toBe('Aprobar ahora')
  })

  it('usa el confirm del proyecto si lo trae', () => {
    const defs = [{ id: 'deploy', label: 'Desplegar', confirm: 'Se despliega a prod.' }]
    const copy = confirmCopy(actionOf('deploy', defs), [item({ action_defs: defs })])
    expect(copy).toEqual({ text: 'Se despliega a prod.', label: 'Desplegar ahora' })
  })

  it('la acción principal va en la fila y el resto como secundarias', () => {
    const q = build([prd(1)])
    expect(q.first?.action?.id).toBe('approve_prd')
    expect(q.first?.secondary.map((a) => a.id)).toEqual(['back_to_refine'])
  })
})

describe('detalle', () => {
  it('el error crudo va una sola vez (tech) y lo del agente aparte', () => {
    const q = build([crash(1), doubt(2)])
    expect(q.first?.detail).toEqual({ happened: 'La corrida falló', tech: '{"status":502}' })
    expect((q.rest[0] as QueueEntry).detail).toMatchObject({
      said: '¿+57 o error?',
      saidBy: 'El refiner dice',
    })
  })

  it('no repite el error si why o agent_said son el mismo texto', () => {
    const same = crash(1)
    same.why = '{"status":502}'
    same.agent_said = '{"status":502}'
    expect(build([same]).first?.detail).toEqual({ happened: '', tech: '{"status":502}' })
  })
})

describe('pipeline, corriendo y feed', () => {
  it('con capacity cuenta ejecuciones, no tarjetas', () => {
    const q = build([running, queued], {
      capacity: { running: 2, waiting: 0, paused: 0, max_concurrent: 3, free: 1 },
    })
    expect(q.pipeline).toEqual({ running: 2, waiting: 0, free: 1, max: 3, source: 'capacity' })
  })

  it('sin capacity (runner viejo) cuenta los items run/queue', () => {
    expect(build([running, queued, doubt(1)]).pipeline).toEqual({
      running: 1,
      waiting: 1,
      source: 'items',
    })
  })

  it('lista lo que corre con agente, antigüedad y «Detener…» si se ofrece', () => {
    const [r] = build([running, item({ ...queued, group: 'run', ref: 'acme/api#92' })]).running
    expect(r).toMatchObject({
      short: 'api#90',
      agent: 'implementer',
      age: { text: '12 min' },
      stop: { id: 'stop', label: 'Detener…', confirms: true },
    })
  })

  it('el feed sale con refs cortos y los lugares libres', () => {
    const q = build([], {
      capacity: { running: 2, waiting: 0, paused: 0, max_concurrent: 3, free: 1 },
      feed: {
        title: 'Qué le das al pipeline',
        entries: [
          {
            ref: 'la-haus/subscriptions#1203',
            title: 'Auditoría',
            url: 'u',
            action: { id: 'to_refine', label: '→ Refine' },
          },
        ],
      },
    })
    expect(q.feed).toEqual({
      title: 'Qué le das al pipeline',
      free: 1,
      entries: [
        {
          ref: 'la-haus/subscriptions#1203',
          short: 'subs#1203',
          url: 'u',
          title: 'Auditoría',
          action: { id: 'to_refine', label: '→ Refine' },
        },
      ],
    })
  })

  it('tolera campos ausentes: sin view, capacity, feed ni hygiene', () => {
    const q = build([item({ chips: undefined, execution: undefined, pr: undefined, actions: [] })])
    expect(q.feed).toBeNull()
    expect(q.hygiene).toEqual([])
    expect(q.first?.action).toBeUndefined()
    expect(q.first?.verb).toBe('Mergear el PR')
    expect(q.running).toEqual([])
  })
})
