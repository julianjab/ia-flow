import type { ExecutionLog } from '@ia-flow/shared'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import RunRow from '../RunRow.vue'

function exec(overrides: Partial<ExecutionLog> = {}): ExecutionLog {
  return {
    id: 'e-1',
    projectId: 'p-1',
    taskId: '1240',
    taskTitle: 'Agregar SID al envío de SMS',
    agentId: 'implementer',
    providerId: 'anthropic-api',
    startedAt: '2025-01-01T00:00:00Z',
    finishedAt: '2025-01-01T00:06:40Z',
    outcome: 'error',
    errorMsg: null,
    stopReason: null,
    ...overrides,
  }
}

const base = { execution: exec(), title: 'Agregar SID al envío de SMS' }
const global = { stubs: { RouterLink: { props: ['to'], template: '<a :href="to"><slot /></a>' } } }

describe('RunRow', () => {
  it('el glifo y la razón salen del vocabulario compartido, no de un badge propio', () => {
    // Es lo que hace que el mismo run se lea igual acá, en Tareas y en Qué
    // sigue. Un ✕ nunca va sin su motivo al lado.
    const w = mount(RunRow, {
      props: { ...base, execution: exec({ failureClass: 'tool_failure' }) },
      global,
    })
    expect(w.find('.rr__anchor .esl').exists()).toBe(true)
    expect(w.get('.rr__state').text()).toContain('falló')
    expect(w.get('.rr__state').text()).toContain('tool_failure')
  })

  it('`#1240` es link al issue cuando hay URL', () => {
    const w = mount(RunRow, {
      props: { ...base, issueLabel: '#1240', titleHref: 'https://github.com/o/r/issues/1240' },
      global,
    })
    const link = w.get('.rr__issue a')
    expect(link.text()).toBe('#1240')
    expect(link.attributes('href')).toBe('https://github.com/o/r/issues/1240')
  })

  it('sin número de issue la columna queda vacía, no inventa un id', () => {
    // Un node id de Projects V2 en la columna más angosta no identifica nada.
    const w = mount(RunRow, { props: base, global })
    expect(w.get('.rr__issue').text()).toBe('')
  })

  // Sin `titleHref` (la URL del issue en el provider puede no haberse podido
  // resolver) el título es lo único que queda para identificar la fila — sin
  // `taskHref` de respaldo, la fila no llevaba a ningún lado.
  it('sin URL del issue, el título linkea a la tarea en ia-flow', () => {
    const w = mount(RunRow, {
      props: { ...base, taskHref: '/projects/p-1/tareas?taskId=1240' },
      global,
    })
    const link = w.get('.rr__title-text a')
    expect(link.text()).toBe('Agregar SID al envío de SMS')
    expect(link.attributes('href')).toBe('/projects/p-1/tareas?taskId=1240')
  })

  it('con número de issue pero sin URL, el número linkea a la tarea en ia-flow', () => {
    const w = mount(RunRow, {
      props: { ...base, issueLabel: '#1240', taskHref: '/projects/p-1/tareas?taskId=1240' },
      global,
    })
    const link = w.get('.rr__issue a')
    expect(link.text()).toBe('#1240')
    expect(link.attributes('href')).toBe('/projects/p-1/tareas?taskId=1240')
  })

  it('sin agente dice `—`: el guión es "no hay", no un nombre vacío', () => {
    const w = mount(RunRow, { props: base, global })
    expect(w.get('.rr__agent').text()).toBe('—')
  })

  it('sin verbo no hay renglón de verbo', () => {
    // Una fila que cerró bien no tiene nada que hacer, y una línea vacía la
    // haría más alta que sus vecinas sin decir nada.
    const w = mount(RunRow, { props: base, slots: { verb: '<button>→ Resolver</button>' }, global })
    expect(w.find('.rr__verb').exists()).toBe(false)
  })

  it('con `hasVerb` el slot se dibuja', () => {
    const w = mount(RunRow, {
      props: { ...base, hasVerb: true },
      slots: { verb: '<button class="v">→ Resolver</button>' },
      global,
    })
    expect(w.get('.rr__verb .v').text()).toBe('→ Resolver')
  })

  it('abre por click y por teclado', async () => {
    const w = mount(RunRow, { props: base, global })
    await w.trigger('click')
    await w.trigger('keydown', { key: 'Enter' })
    expect(w.emitted('open')).toHaveLength(2)
  })

  it('una tecla sobre un control anidado NO abre la fila', async () => {
    // Sin este gate, un espacio sobre el verbo abre el detalle EN VEZ de
    // activar el verbo.
    const w = mount(RunRow, {
      props: { ...base, hasVerb: true },
      slots: { verb: '<button class="v">→ Resolver</button>' },
      global,
    })
    await w.get('.v').trigger('keydown', { key: ' ' })
    expect(w.emitted('open')).toBeUndefined()
  })

  it('sin `clickable` no toma foco ni es un botón', () => {
    const w = mount(RunRow, { props: { ...base, clickable: false }, global })
    expect(w.attributes('role')).toBeUndefined()
    expect(w.attributes('tabindex')).toBeUndefined()
  })
})
