import EventTypePicker from '@/features/rules/EventTypePicker.vue'
import { EVENT_CATALOG } from '@ia-flow/shared'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

const mountPicker = (modelValue = '') => mount(EventTypePicker, { props: { modelValue } })

const openList = async (w: ReturnType<typeof mountPicker>) => {
  await w.find('.etp-toggle').trigger('click')
  return w
}

const types = (w: ReturnType<typeof mountPicker>) => w.findAll('.etp-type').map((e) => e.text())

describe('EventTypePicker', () => {
  it('lista el catálogo con su descripción', async () => {
    const w = await openList(mountPicker())
    expect(types(w)).toHaveLength(EVENT_CATALOG.length)
    // La descripción es la mitad del valor: `pr.synchronize` no le dice nada a
    // nadie hasta que se lee qué significa.
    expect(w.text()).toContain('Llegaron commits nuevos')
  })

  it('filtra por lo que se está escribiendo', async () => {
    const w = await openList(mountPicker('pr.'))
    expect(types(w).every((t) => t.startsWith('pr.'))).toBe(true)
    expect(types(w).length).toBeGreaterThan(1)
  })

  // Si alguien tipeó `pr.` y clickea `pr.opened`, quiere `pr.opened` — no
  // `pr., pr.opened`.
  it('reemplaza el token a medio escribir en vez de anexar', async () => {
    const w = await openList(mountPicker('pr.'))
    await w.findAll('.etp-item')[0].trigger('click')
    expect(w.emitted('update:modelValue')?.at(-1)?.[0]).toBe('pr.opened')
  })

  it('anexa cuando ya hay uno elegido', async () => {
    const w = await openList(mountPicker('ci.finished, '))
    await w.findAll('.etp-item')[0].trigger('click')
    expect(String(w.emitted('update:modelValue')?.at(-1)?.[0])).toContain('ci.finished,')
  })

  it('no vuelve a sugerir lo ya elegido', async () => {
    const w = await openList(mountPicker('pr.opened, '))
    expect(types(w)).not.toContain('pr.opened')
  })

  // El bus no valida contra el catálogo: un `emit` con un tipo propio, o un
  // evento de otra versión, son configuraciones legítimas.
  it('deja claro que acepta valores desconocidos', async () => {
    const w = await openList(mountPicker('mi.evento.propio'))
    expect(types(w)).toHaveLength(0)
    expect(w.text()).toContain('se guarda igual')
  })
})
