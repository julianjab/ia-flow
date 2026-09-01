import { describe, expect, test } from 'bun:test'
import { SCHEDULE_TICK, matchesCron, parseCron, scheduleTickEvent } from './schedule.js'

function at(iso: string) {
  return new Date(iso)
}

describe('parseCron', () => {
  test('acepta las formas que el parser soporta', () => {
    expect(parseCron('* * * * *')).not.toBeNull()
    expect(parseCron('0 9 * * *')).not.toBeNull()
    expect(parseCron('*/15 * * * *')).not.toBeNull()
    expect(parseCron('0 9,17 * * 1')).not.toBeNull()
  })

  test('rechaza lo que no entiende, en vez de adivinar', () => {
    // Se valida al guardar la regla: una expresión rota que sólo falla en
    // runtime es una regla que nunca dispara y nadie sabe por qué.
    expect(parseCron('* * * *')).toBeNull()
    expect(parseCron('1-5 * * * *')).toBeNull()
    expect(parseCron('@daily')).toBeNull()
    expect(parseCron('60 * * * *')).toBeNull()
    expect(parseCron('*/0 * * * *')).toBeNull()
    expect(parseCron('')).toBeNull()
  })
})

describe('matchesCron', () => {
  test('todo comodín matchea siempre', () => {
    expect(matchesCron(parseCron('* * * * *')!, at('2026-03-15T10:30:00'))).toBe(true)
  })

  test('hora y minuto exactos', () => {
    const spec = parseCron('30 9 * * *')!
    expect(matchesCron(spec, at('2026-03-15T09:30:00'))).toBe(true)
    expect(matchesCron(spec, at('2026-03-15T09:31:00'))).toBe(false)
    expect(matchesCron(spec, at('2026-03-15T10:30:00'))).toBe(false)
  })

  test('pasos', () => {
    const spec = parseCron('*/15 * * * *')!
    expect(matchesCron(spec, at('2026-03-15T10:00:00'))).toBe(true)
    expect(matchesCron(spec, at('2026-03-15T10:15:00'))).toBe(true)
    expect(matchesCron(spec, at('2026-03-15T10:16:00'))).toBe(false)
  })

  test('los dos campos de día se combinan con OR, no con AND', () => {
    // Es la regla de cron de toda la vida: `0 9 1 * 1` significa "el día 1 O
    // los lunes". Sorprende, pero cambiarla haría que una expresión copiada de
    // cualquier lado signifique otra cosa acá.
    const spec = parseCron('0 9 1 * 1')!
    // 2026-03-01 es domingo — matchea por día del mes.
    expect(matchesCron(spec, at('2026-03-01T09:00:00'))).toBe(true)
    // 2026-03-02 es lunes — matchea por día de la semana.
    expect(matchesCron(spec, at('2026-03-02T09:00:00'))).toBe(true)
    // 2026-03-03 es martes y no es día 1.
    expect(matchesCron(spec, at('2026-03-03T09:00:00'))).toBe(false)
  })

  test('con un solo campo de día restringido se aplica ése', () => {
    const spec = parseCron('0 9 * * 1')!
    expect(matchesCron(spec, at('2026-03-02T09:00:00'))).toBe(true)
    expect(matchesCron(spec, at('2026-03-03T09:00:00'))).toBe(false)
  })
})

describe('scheduleTickEvent', () => {
  test('el id es idempotente por minuto', () => {
    // Dos barridos que se solapan sobre el mismo minuto producen el mismo id,
    // y el dedupe del bus se come el segundo. Sin eso, un tick que tarda más
    // que el intervalo dispararía la regla dos veces.
    const a = scheduleTickEvent('r1', at('2026-03-15T09:00:10Z'))
    const b = scheduleTickEvent('r1', at('2026-03-15T09:00:50Z'))
    expect(a.id).toBe(b.id)
    expect(a.type).toBe(SCHEDULE_TICK)
  })

  test('dos reglas en el mismo minuto NO comparten id', () => {
    const a = scheduleTickEvent('r1', at('2026-03-15T09:00:00Z'))
    const b = scheduleTickEvent('r2', at('2026-03-15T09:00:00Z'))
    expect(a.id).not.toBe(b.id)
  })

  test('una regla de proyecto lleva su scope', () => {
    const e = scheduleTickEvent('r1', at('2026-03-15T09:00:00Z'), 'p1')
    expect(e.scope).toEqual({ projectId: 'p1' })
    // Una regla global no puede inventar un proyecto.
    expect(scheduleTickEvent('r1', at('2026-03-15T09:00:00Z'), null).scope).toEqual({})
  })
})
