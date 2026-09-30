import { describe, expect, it } from 'bun:test'
import type { TraceEntry } from '@ia-flow/shared'
import { TRACE_PAGE_CHARS, traceWindow } from './tracePage.js'

const entry = (name: string, attributes: Record<string, unknown> = {}): TraceEntry => ({
  kind: 'log',
  name,
  level: 'info',
  start_time: '2026-09-30T22:01:00.000Z',
  trace_id: 't',
  span_id: 's',
  execution_id: 'e',
  origin: 'runner',
  attributes,
})

const tool = (name: string, input = '{}') =>
  entry('tool.call', { 'gen_ai.tool.name': name, 'ia.tool.input': input })

describe('traceWindow', () => {
  it('sin fields trae lo justo para ver qué pasó, sin payloads', () => {
    const page = traceWindow('e', [tool('Bash', 'ls')])

    expect(page.entries).toEqual([
      {
        index: 0,
        at: '2026-09-30T22:01:00.000Z',
        kind: 'log',
        name: 'tool.call',
        tool: 'Bash',
        level: 'info',
      },
    ])
    expect(page.attribute_keys).toEqual(['gen_ai.tool.name', 'ia.tool.input'])
  })

  it('pagina en orden y dice desde dónde sigue', () => {
    const entries = Array.from({ length: 5 }, (_, i) => tool(`t${i}`))

    const first = traceWindow('e', entries, { limit: 2 })
    expect(first.entries.map((e) => e.tool)).toEqual(['t0', 't1'])
    expect(first.next_offset).toBe(2)

    const last = traceWindow('e', entries, { offset: 4, limit: 2 })
    expect(last.entries.map((e) => e.tool)).toEqual(['t4'])
    expect(last.next_offset).toBeNull()
  })

  it('llena la página hasta el presupuesto y nunca corta una entrada', () => {
    const big = 'x'.repeat(TRACE_PAGE_CHARS * 0.6)
    const entries = [tool('a', big), tool('b', big), tool('c', big)]

    const page = traceWindow('e', entries, { fields: ['attributes.ia.tool.input'] })

    expect(page.returned).toBe(1)
    expect(page.next_offset).toBe(1)
    expect(page.entries[0]?.attributes).toEqual({ 'ia.tool.input': big })
  })

  it('una entrada que sola pasa el presupuesto viene igual, entera', () => {
    const huge = 'x'.repeat(TRACE_PAGE_CHARS * 2)

    const page = traceWindow('e', [tool('a', huge), tool('b')], { fields: ['attributes'] })

    expect(page.returned).toBe(1)
    expect(page.entries[0]?.attributes).toMatchObject({ 'ia.tool.input': huge })
    expect(page.next_offset).toBe(1)
  })

  it('contains filtra sin perder la posición original ni el total', () => {
    const entries = [
      entry('agent.session_start'),
      tool('mcp__ia-flow__check_prd_zona_de_impacto', '{"items":[1]}'),
      tool('Bash'),
      tool('mcp__ia-flow__submit_done'),
    ]

    const page = traceWindow('e', entries, { contains: 'CHECK_PRD' })

    expect(page.total).toBe(4)
    expect(page.matched).toBe(1)
    expect(page.entries.map((e) => e.index)).toEqual([1])
  })

  it('contains sin coincidencias devuelve una página vacía, no un error', () => {
    const page = traceWindow('e', [tool('Bash')], { contains: 'check_prd' })

    expect(page).toMatchObject({ matched: 0, returned: 0, next_offset: null, entries: [] })
  })

  it('fields pide campos y atributos puntuales', () => {
    const page = traceWindow('e', [tool('Bash', 'ls')], {
      fields: ['name', 'attributes.ia.tool.input', 'attributes.no.existe'],
    })

    expect(page.entries).toEqual([
      { index: 0, name: 'tool.call', attributes: { 'ia.tool.input': 'ls' } },
    ])
  })

  it('un campo desconocido es un error que dice cuáles hay', () => {
    expect(() => traceWindow('e', [tool('Bash')], { fields: ['nombre'] })).toThrow(
      /Campos desconocidos: nombre\. Hay: at,/,
    )
  })
})
