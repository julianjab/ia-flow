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

function runningRun() {
  return {
    id: 'r1',
    projectId: 'ia-flow',
    taskId: 'I_1',
    taskTitle: 'T',
    agentId: 'implementer',
    providerId: 'anthropic-api',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    outcome: null,
    errorMsg: null,
    stopReason: null,
  }
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

  // El botón vive en la barra de acciones del pie: es LA acción de la
  // pantalla cuando la tarea no corrió, no un control más del cuerpo.
  it('sin run, la acción principal del pie es correr', async () => {
    const wrapper = mountModal()
    const primary = need('.modal-foot .btn--primary')
    expect(primary.textContent).toContain('Correr ahora')
    primary.click()
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('run')).toHaveLength(1)
  })

  it('con un pedido en vuelo el botón queda deshabilitado', () => {
    mountModal({ running: true })
    expect((need('.modal-foot .btn--primary') as HTMLButtonElement).disabled).toBe(true)
  })

  // Cuando algo está corriendo NO hay primary: no hay nada que iniciar, y la
  // única acción destructiva va última.
  it('con un run en vuelo ofrece logs y abortar, sin primary', () => {
    mountModal({ execution: runningRun() })
    expect(el('.modal-foot .btn--primary')).toBeNull()
    expect(need('.modal-foot').textContent).toContain('Ver logs en vivo')
    expect(need('.modal-foot .btn--danger').textContent).toContain('Abortar')
  })

  it('un fallo ofrece reintentar como acción principal', () => {
    mountModal({
      execution: { ...runningRun(), finishedAt: new Date().toISOString(), outcome: 'error' },
    })
    expect(need('.modal-foot .btn--primary').textContent).toContain('Reintentar')
  })

  // El botón de abortar de esta misma pantalla escribe `cancelled`: pintarlo
  // verde con "Ver PR" sería decir que terminó bien el run que acabás de matar.
  it('un run cancelado o cortado ofrece reintentar, no "ver PR"', () => {
    for (const outcome of ['cancelled', 'truncated'] as const) {
      document.body.innerHTML = ''
      mountModal({
        execution: { ...runningRun(), finishedAt: new Date().toISOString(), outcome },
        pullRequests: [
          { number: 152, url: 'https://github.com/o/r/pull/152', state: 'open', isDraft: false },
        ],
      })
      expect(need('.state-card').classList.contains('is-stopped')).toBe(true)
      expect(need('.modal-foot .btn--primary').textContent).toContain('Reintentar')
    }
  })

  // Aprobar/mergear desde la app no existe: la acción abre el PR en GitHub en
  // vez de prometer un botón que no hace nada.
  it('una tarea terminada con PR abierto ofrece verlo en GitHub', () => {
    mountModal({
      execution: { ...runningRun(), finishedAt: new Date().toISOString(), outcome: 'success' },
      pullRequests: [
        { number: 152, url: 'https://github.com/o/r/pull/152', state: 'open', isDraft: false },
      ],
    })
    const primary = need('.modal-foot .btn--primary') as HTMLAnchorElement
    expect(primary.tagName).toBe('A')
    expect(primary.href).toContain('/pull/152')
  })

  it('la tarjeta de estado lleva la ranura del estado', () => {
    mountModal({ execution: runningRun() })
    expect(need('.state-card').classList.contains('is-running')).toBe(true)
    expect(need('.state-meta').textContent).toContain('implementer')
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
    expect(need('.repos-block .empty').textContent).toContain('no reporta ningún repo')
  })
})
