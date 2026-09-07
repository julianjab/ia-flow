import ExecutionStatusLine from '@/components/ExecutionStatusLine.vue'
import type { ExecutionLog } from '@ia-flow/shared'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

function run(over: Partial<ExecutionLog> = {}): ExecutionLog {
  return {
    id: 'r1',
    projectId: 'p1',
    taskId: 't1',
    taskTitle: 'T',
    agentId: 'implementer',
    providerId: 'tmux-claude',
    startedAt: new Date(Date.now() - 120_000).toISOString(),
    finishedAt: new Date(Date.now() - 60_000).toISOString(),
    outcome: 'success',
    errorMsg: null,
    stopReason: null,
    durationMs: 125_000,
    ...over,
  } as ExecutionLog
}

const line = (props: Record<string, unknown>) => mount(ExecutionStatusLine, { props }).find('.esl')

describe('ExecutionStatusLine', () => {
  // El estado que motivó el rediseño entero.
  it('sin runs y sabiéndolo, dice "sin ejecutar"', () => {
    const el = line({ execution: null, runsKnown: true })
    expect(el.text()).toContain('sin ejecutar')
    expect(el.classes()).toContain('esl--never')
  })

  // "No sé" no se dibuja como "no hay": mientras el agregado no llegó, la
  // línea no existe.
  it('sin saber si corrió, no pinta nada', () => {
    expect(line({ execution: null }).exists()).toBe(false)
  })

  it('un run vivo se muestra corriendo, con el agente y sin pasos inventados', () => {
    const el = line({ execution: run({ finishedAt: null, outcome: null }) })
    expect(el.classes()).toContain('esl--running')
    expect(el.text()).toContain('corriendo')
    expect(el.text()).toContain('implementer')
    // El server no guarda pasos todavía: `3/5` sería inventado.
    expect(el.text()).not.toMatch(/\d\/\d/)
  })

  // Un ✕ nunca aparece sin el motivo al lado.
  it('un fallo lleva su motivo pegado', () => {
    const el = line({ execution: run({ outcome: 'error', failureClass: 'tests' }) })
    expect(el.classes()).toContain('esl--failed')
    expect(el.text()).toContain('falló · tests')
  })

  it('un run terminado dice cuándo y cuánto', () => {
    const el = line({ execution: run() })
    expect(el.text()).toContain('terminó')
    expect(el.text()).toContain('2m 05s')
  })

  it('bloqueada gana sobre "sin ejecutar"', () => {
    const el = line({ execution: null, runsKnown: true, blocked: true })
    expect(el.classes()).toContain('esl--blocked')
    expect(el.text()).toContain('bloqueada')
  })

  it('ignorada lleva el motivo que dio run-preview', () => {
    const el = line({
      execution: null,
      runsKnown: true,
      ignoredReason: 'ninguna regla matcheó su status',
    })
    expect(el.classes()).toContain('esl--ignored')
    expect(el.text()).toContain('ninguna regla matcheó su status')
  })

  // Un run vivo manda sobre todo lo demás: es lo que está pasando AHORA.
  it('corriendo gana sobre bloqueada', () => {
    const el = line({ execution: run({ finishedAt: null, outcome: null }), blocked: true })
    expect(el.classes()).toContain('esl--running')
  })

  it('"1 intento" no se dice; dos sí', () => {
    expect(line({ execution: run(), attempts: 1 }).text()).not.toContain('intento')
    expect(line({ execution: run(), attempts: 3 }).text()).toContain('3 intentos')
  })

  // Sólo se afirma `sin PR` cuando el provider modela PRs.
  it('no afirma "sin PR" si el provider no sabe de PRs', () => {
    expect(line({ execution: null, runsKnown: true }).text()).not.toContain('sin PR')
    expect(line({ execution: null, runsKnown: true, pullRequestsKnown: true }).text()).toContain(
      'sin PR',
    )
  })
})
