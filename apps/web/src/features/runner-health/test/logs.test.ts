import type { RunnerLogLine } from '@ia-flow/shared'
import { describe, expect, it } from 'vitest'
import { appendLines, clockOf, copyText, LOG_FILTERS, levelOf } from '../logs'

const line = (seq: number, over: Partial<RunnerLogLine> = {}): RunnerLogLine => ({
  seq,
  time: '2026-10-15T12:00:01.000Z',
  level: 'info',
  scope: 'engine',
  message: `m${seq}`,
  ...over,
})

describe('logs', () => {
  it('el segmentado: Todo no filtra, Avisos pide warn y Errores error', () => {
    expect(LOG_FILTERS.map((f) => f.label)).toEqual(['Todo', 'Avisos', 'Errores'])
    expect(levelOf('all')).toBeUndefined()
    expect(levelOf('warn')).toBe('warn')
    expect(levelOf('error')).toBe('error')
  })

  it('suma lo nuevo sin repetir y guarda las últimas', () => {
    const merged = appendLines([line(1), line(2)], [line(2), line(3), line(4)], 3)
    expect(merged.map((l) => l.seq)).toEqual([2, 3, 4])
  })

  it('la hora local en HH:MM:SS; lo que no es fecha, tal cual', () => {
    expect(clockOf('2026-10-15T12:00:01.000Z')).toMatch(/^\d{2}:\d{2}:01$/)
    expect(clockOf('ayer')).toBe('ayer')
  })

  it('copia una línea por renglón, como la imprime el proceso', () => {
    const text = copyText([
      line(1),
      line(2, { level: 'error', scope: 'provider', message: 'timeout', fields: 'task=#4301' }),
    ])
    expect(text).toBe(
      '2026-10-15T12:00:01.000Z INFO [engine] m1\n2026-10-15T12:00:01.000Z ERROR [provider] timeout task=#4301',
    )
  })
})
