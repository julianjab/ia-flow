import type { ExecutionLog } from '@ia-flow/shared'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import RunVerdict from '../RunVerdict.vue'

function exec(overrides: Partial<ExecutionLog> = {}): ExecutionLog {
  return {
    id: 'e-1',
    projectId: 'p-1',
    taskId: '1240',
    taskTitle: 'Agregar SID al envío de SMS',
    agentId: 'implementer',
    providerId: 'anthropic-api',
    startedAt: '2025-01-01T09:34:00Z',
    finishedAt: '2025-01-01T09:40:40Z',
    outcome: 'error',
    errorMsg: 'AssertionError: sid is None',
    stopReason: 'pytest exit 1',
    failureClass: 'tool_failure',
    ...overrides,
  }
}

const stubs = { RouterLink: { template: '<a><slot /></a>' } }

describe('RunVerdict', () => {
  it('el veredicto es glifo, outcome y duración — en ese orden y en grande', () => {
    const w = mount(RunVerdict, { props: { execution: exec() }, global: { stubs } })
    const head = w.get('.rv__headline').text()
    expect(head).toContain('✕')
    expect(head).toContain('falló')
    expect(head).toContain('6m 40s')
    expect(w.get('.rv__task').text()).toContain('Agregar SID al envío de SMS')
  })

  it('la meta son los tres datos que ubican el run, sin los que no vinieron', () => {
    // Sin `model` la línea no dice `· null`: se arma con lo que hay.
    const w = mount(RunVerdict, { props: { execution: exec() }, global: { stubs } })
    expect(w.get('.rv__meta').text()).toContain('implementer · anthropic-api')
    expect(w.get('.rv__meta').text()).not.toContain('· null')

    const withModel = mount(RunVerdict, {
      props: { execution: exec({ model: 'sonnet' }) },
      global: { stubs },
    })
    expect(withModel.get('.rv__meta').text()).toContain('implementer · anthropic-api · sonnet')
  })

  it('la causa lleva el error LITERAL, no un resumen', () => {
    const w = mount(RunVerdict, { props: { execution: exec() }, global: { stubs } })
    const cause = w.get('[data-testid="run-cause"]')
    // La clase pasa por el diccionario compartido: `unknown` crudo se lee como
    // un bug de la UI, no como "el server no pudo clasificarlo".
    expect(cause.text()).toContain('tools fallando · pytest exit 1')
    expect(cause.get('.rc__raw').text()).toBe('AssertionError: sid is None')
  })

  it('un run que salió bien no tiene banda de causa', () => {
    // Una banda «qué salió mal» sobre un éxito promete una respuesta que no
    // existe. Se omite entera (R13).
    const w = mount(RunVerdict, {
      props: { execution: exec({ outcome: 'success', errorMsg: null, failureClass: null }) },
      global: { stubs },
    })
    expect(w.find('[data-testid="run-cause"]').exists()).toBe(false)
    expect(w.get('.rv__headline').text()).toContain('terminó')
  })

  it('un fallo sin nada literal que mostrar tampoco la dibuja', () => {
    const w = mount(RunVerdict, {
      props: { execution: exec({ errorMsg: null, stopReason: null, failureClass: null }) },
      global: { stubs },
    })
    expect(w.find('[data-testid="run-cause"]').exists()).toBe(false)
  })

  it('mientras corre dice `corriendo`, y no hay causa', () => {
    const w = mount(RunVerdict, {
      props: { execution: exec({ finishedAt: null, outcome: null }) },
      global: { stubs },
    })
    expect(w.get('.rv__headline').text()).toContain('corriendo')
    expect(w.get('.rv__meta').text()).toContain('sigue vivo')
    expect(w.find('[data-testid="run-cause"]').exists()).toBe(false)
  })

  it('el aviso de lentitud compara contra el promedio, y sólo desde 2×', () => {
    // Por debajo de 2× la comparación no dice nada: un run puede tardar el
    // doble por el tamaño del issue, y avisar siempre enseña a ignorar.
    // Un run vivo mide contra el reloj, así que arranca hace un minuto de
    // verdad: con una fecha fija el "lleva" sería de meses.
    const running = exec({
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      finishedAt: null,
      outcome: null,
    })
    const cerca = mount(RunVerdict, {
      props: { execution: running, avgDurationMs: 60 * 60 * 1000 },
      global: { stubs },
    })
    expect(cerca.find('[data-testid="run-verdict-slow"]').exists()).toBe(false)

    const lejos = mount(RunVerdict, {
      props: { execution: running, avgDurationMs: 10_000 },
      global: { stubs },
    })
    expect(lejos.get('[data-testid="run-verdict-slow"]').text()).toContain('el promedio')
  })

  it('sin promedio no hay aviso — un run lento sin comparación es un run', () => {
    const w = mount(RunVerdict, {
      props: {
        execution: exec({
          startedAt: new Date(Date.now() - 60_000).toISOString(),
          finishedAt: null,
          outcome: null,
        }),
        avgDurationMs: null,
      },
      global: { stubs },
    })
    expect(w.find('[data-testid="run-verdict-slow"]').exists()).toBe(false)
  })

  it('copiar el error avisa hacia arriba; sin error, no se ofrece', () => {
    const w = mount(RunVerdict, { props: { execution: exec() }, global: { stubs } })
    w.get('[data-testid="run-cause-copy"]').trigger('click')
    expect(w.emitted('copyError')).toHaveLength(1)

    const sinError = mount(RunVerdict, {
      props: { execution: exec({ errorMsg: null }) },
      global: { stubs },
    })
    expect(sinError.find('[data-testid="run-cause-copy"]').exists()).toBe(false)
  })
})
