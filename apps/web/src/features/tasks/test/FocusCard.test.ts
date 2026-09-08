import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import FocusCard from '../FocusCard.vue'

const FOCUS = {
  headline: 'Un solo cuello de botella: el PR #12 traba 4 tareas.',
  picks: [
    { taskId: 't1', why: 'El PR ya tiene CI verde.', effort: 'quick' as const },
    { taskId: 't2', why: 'Falla por el mismo timeout que t1.', effort: 'deep' as const },
  ],
  clusters: [{ label: 'timeout de Twilio', taskIds: ['t1', 't2'] }],
  computedAt: new Date().toISOString(),
}

function render(props: Partial<Record<string, unknown>> = {}) {
  return mount(FocusCard, {
    props: {
      projectId: 'p1',
      focus: FOCUS,
      loading: false,
      failed: false,
      waitingCount: 4,
      titles: { t1: 'Webhook de Wompi', t2: 'SID en el SMS' },
      ...props,
    },
  })
}

beforeEach(() => {
  localStorage.clear()
})

describe('FocusCard', () => {
  it('sin foco no dibuja NADA: ni card, ni hueco, ni cartel', () => {
    const w = render({ focus: null })
    expect(w.find('[data-testid="focus-card"]').exists()).toBe(false)
    expect(w.find('[data-testid="focus-loading"]').exists()).toBe(false)
    // Sólo quedan los comentarios del template: ni un elemento en el DOM.
    expect(w.element.querySelectorAll('*')).toHaveLength(0)
  })

  it('cargando es UNA línea, no un esqueleto de la card expandida', () => {
    const w = render({ focus: null, loading: true })
    expect(w.find('[data-testid="focus-loading"]').text()).toContain('leyendo las 4 filas')
    expect(w.find('[data-testid="focus-card"]').exists()).toBe(false)
  })

  it('degradado dice qué falló y qué sigue siendo cierto, y es un solo blanco táctil', async () => {
    const w = render({ focus: null, failed: true })
    const box = w.find('[data-testid="focus-failed"]')
    expect(box.text()).toContain('no se pudo calcular el foco')
    // La segunda línea es lo que separa "no se pudo pensar" de "no hay nada".
    expect(box.text()).toContain('las 4 filas están completas y ordenadas')
    await box.trigger('click')
    expect(w.emitted('retry')).toHaveLength(1)
  })

  it('el fallo gana sobre el estado de carga: un reintento no borra el aviso', () => {
    const w = render({ focus: null, loading: true, failed: true })
    expect(w.find('[data-testid="focus-failed"]').exists()).toBe(true)
    expect(w.find('[data-testid="focus-loading"]').exists()).toBe(false)
  })

  it('la primera visita al proyecto abre expandida', () => {
    const w = render()
    expect(w.findAll('[data-testid^="focus-pick-"]')).toHaveLength(2)
  })

  it('el colapso persiste por proyecto, y no lo reabre un headline nuevo', async () => {
    const w = render()
    await w.find('[data-testid="focus-toggle"]').trigger('click')
    expect(w.findAll('[data-testid^="focus-pick-"]')).toHaveLength(0)
    expect(localStorage.getItem('focus.open.p1')).toBe('0')

    // Otra visita al mismo proyecto, con un foco distinto: sigue cerrada.
    const again = render({ focus: { ...FOCUS, headline: 'otra cosa' } })
    expect(again.findAll('[data-testid^="focus-pick-"]')).toHaveLength(0)
    // Otro proyecto arranca abierto: la preferencia es por proyecto.
    expect(render({ projectId: 'p2' }).findAll('[data-testid^="focus-pick-"]')).toHaveLength(2)
  })

  it('tocar un pick avisa a la pantalla y cierra la card, sin ejecutar ningún verbo (R17)', async () => {
    const w = render()
    await w.find('[data-testid="focus-pick-t1"]').trigger('click')
    expect(w.emitted('go')).toEqual([['t1']])
    expect(w.findAll('[data-testid^="focus-pick-"]')).toHaveLength(0)
  })

  it('el pick usa el título de la fila, no el id', () => {
    expect(render().find('[data-testid="focus-pick-t1"]').text()).toContain('Webhook de Wompi')
  })

  it('`crowded` la dibuja colapsada sin pisar la preferencia guardada', () => {
    const w = render({ crowded: true })
    expect(w.findAll('[data-testid^="focus-pick-"]')).toHaveLength(0)
    // No se escribió nada: cuando el aviso de reorden se vaya, vuelve abierta.
    expect(localStorage.getItem('focus.open.p1')).toBeNull()
  })

  it('los clusters son texto, no botones: FilterByIds todavía no existe', () => {
    const w = render()
    const cluster = w.find('[data-testid="focus-cluster"]')
    expect(cluster.text()).toContain('timeout de Twilio')
    expect(cluster.text()).toContain('2 tareas')
    expect(cluster.element.tagName).toBe('P')
  })

  it('dice cuándo se pensó (R16), porque el resultado viene cacheado', () => {
    const old = new Date(Date.now() - 3 * 60_000).toISOString()
    expect(render({ focus: { ...FOCUS, computedAt: old } }).text()).toContain('hace 3 min')
  })
})
