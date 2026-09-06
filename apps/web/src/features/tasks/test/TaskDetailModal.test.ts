import TaskDetailModal from '@/features/tasks/TaskDetailModal.vue'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'

// El modal se teletransporta al body, así que las queries van contra el DOM y
// no contra el wrapper (que sólo contiene los marcadores del Teleport).
const el = (sel: string) => document.body.querySelector(sel)
const need = (sel: string) => {
  const found = el(sel)
  if (!found) throw new Error(`No se encontró ${sel} en el modal`)
  return found as HTMLElement
}

function mountModal(props: Record<string, unknown> = {}) {
  return mount(TaskDetailModal, {
    props: {
      open: true,
      issueNumber: 138,
      issueTitle: 'Tools de filesystem',
      repos: ['ia-flow'],
      status: 'build',
      ...props,
    },
    attachTo: document.body,
  })
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('TaskDetailModal — correr la tarea', () => {
  // El status es la mitad de la decisión: es contra ESO que se evalúan las
  // reglas, así que el botón no puede pedirlo a ciegas.
  it('dice contra qué status se van a evaluar las reglas', () => {
    mountModal()
    expect(need('.run-status').textContent).toBe('build')
    expect(need('.run-explain').textContent).toContain('sin mover la tarea')
  })

  it('una tarea sin status lo dice en vez de mentir con un valor vacío', () => {
    mountModal({ status: '' })
    expect(need('.run-status').textContent).toBe('sin status')
  })

  it('emite `run` al hacer click', async () => {
    const wrapper = mountModal()
    need('.run-btn').click()
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('run')).toHaveLength(1)
  })

  it('con un pedido en vuelo el botón queda deshabilitado', () => {
    mountModal({ running: true })
    expect((need('.run-btn') as HTMLButtonElement).disabled).toBe(true)
  })

  it('un dispatch efectivo se explica en el modal', () => {
    mountModal({ runResult: { outcome: 'dispatched', status: 'build' } })
    const result = need('.run-result')
    expect(result.textContent).toContain('Corriendo')
    expect(result.classList.contains('is-error')).toBe(false)
  })

  // "Ninguna regla matchea" no es un fallo del server: es config para revisar,
  // y es el caso que hay que poder releer mientras se decide qué cambiar.
  it('"ninguna regla matchea" se marca distinto y nombra el status', () => {
    mountModal({ runResult: { outcome: 'skipped', status: 'done' } })
    const result = need('.run-result')
    expect(result.textContent).toContain('done')
    expect(result.classList.contains('is-error')).toBe(true)
  })

  it('sin resultado todavía no se muestra ninguna línea de veredicto', () => {
    mountModal()
    expect(el('.run-result')).toBeNull()
  })
})

// Los repos son informativos: quién los decide es la fuente, y no todas saben
// persistirlos (`github-issues` los deriva de su config y devuelve 501 ante un
// intento de escritura). Un editor que sólo anda en algunas fuentes es peor
// que un dato.
describe('TaskDetailModal — repos', () => {
  it('los muestra como lectura, sin editor ni guardado', () => {
    const wrapper = mountModal()
    expect(need('.repo-list').textContent).toContain('ia-flow')
    expect(document.body.querySelectorAll('.repo-chip.is-static')).toHaveLength(1)
    expect(wrapper.emitted('save')).toBeUndefined()
    expect(document.body.textContent).not.toContain('Guardar')
  })

  it('una tarea sin repos lo dice en vez de mostrar un hueco', () => {
    mountModal({ repos: [] })
    expect(need('.empty').textContent).toContain('no reporta ningún repo')
  })
})
