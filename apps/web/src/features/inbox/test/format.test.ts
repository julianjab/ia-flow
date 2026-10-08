import { describe, expect, it } from 'vitest'
import {
  clock,
  duration,
  executionStatus,
  tokens,
  traceLine,
  usageLine,
} from '@/features/inbox/format'
import { KIND_LABEL, primaryAction } from '@/features/inbox/labels'
import { actionOf, confirmCopy } from '@/features/inbox/queue/kinds'
import { trace } from '@/features/inbox/test/fixtures'

describe('formato', () => {
  it('duration: segundos, minutos y horas', () => {
    expect(duration(18_000)).toBe('18 s')
    expect(duration(192_000)).toBe('3m 12s')
    expect(duration(3_900_000)).toBe('1h 05m')
  })

  it('tokens: 950 · 38k · 1.2M', () => {
    expect([tokens(950), tokens(38_400), tokens(1_200_000)]).toEqual(['950', '38k', '1.2M'])
  })

  it('usageLine resume lo gastado', () => {
    expect(usageLine({ input_tokens: 38_000, output_tokens: 2_000, cache_read_tokens: 900 })).toBe(
      '38k in · 2k out · 900 caché',
    )
  })

  it('clock devuelve el ISO crudo si no parsea', () => {
    expect(clock('ayer')).toBe('ayer')
    expect(clock('2026-01-01T10:01:02.000Z')).toMatch(/^\d\d:\d\d:\d\d$/)
  })

  it('executionStatus traduce los cinco estados', () => {
    expect(executionStatus('failed')).toBe('falló')
    expect(executionStatus('paused')).toBe('pausada')
  })

  it('traceLine: un log usa su nivel; un span con error se ve como error', () => {
    expect(traceLine(trace({ level: 'warn', scope: 'agent' }))).toMatchObject({
      level: 'warn',
      origin: 'agent',
    })
    const failed = traceLine(
      trace({
        kind: 'span',
        phase: 'end',
        status: 'error',
        status_message: 'timeout',
        duration_ms: 65_000,
        name: 'bash_run',
      }),
    )
    expect(failed.level).toBe('error')
    expect(failed.message).toBe('bash_run (1m 05s) — timeout')
  })
})

describe('labels', () => {
  it('tiene copy para cada caso, incluido idle', () => {
    expect(KIND_LABEL.idle).toBe('Sin pendientes')
    expect(KIND_LABEL.merge).toBe('Listo para mergear')
  })

  it('cada caso de «te necesita» y «falló» tiene UNA acción principal; correr y esperar, ninguna', () => {
    expect(primaryAction('merge')).toBe('merge')
    expect(primaryAction('review')).toBe('rerun_review')
    expect(primaryAction('doubt')).toBe('answer_and_unblock')
    expect(primaryAction('crash')).toBe('retry')
    expect(primaryAction('agent')).toBeUndefined()
    expect(primaryAction('dep')).toBeUndefined()
  })

  it('la confirmación dice qué se firma, dónde y con tu usuario de GitHub', () => {
    const stop = confirmCopy(actionOf('stop'), [{ ref: 'acme/api#1' }], 'ada')
    expect(stop.text).toContain('api#1')
    expect(stop.text).toContain('@ada')
    expect(stop.label).toBe('Detener ahora')
    const custom = confirmCopy(
      actionOf('archive', [{ id: 'archive', label: 'Archivar', confirm: 'x' }]),
      [{ ref: 'acme/api#1' }, { ref: 'acme/api#2' }],
      'ada',
    )
    expect(custom.text).toBe(
      'Se ejecuta «Archivar» en api#1 y api#2 con tu usuario de GitHub (@ada).',
    )
    expect(custom.label).toBe('Archivar ahora')
  })
})
