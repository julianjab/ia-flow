import EventTypePicker from '@/features/rules/EventTypePicker.vue'
import { EVENT_CATALOG } from '@ia-flow/shared'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

const mountPicker = (modelValue = '') => mount(EventTypePicker, { props: { modelValue } })

const openList = async (w: ReturnType<typeof mountPicker>) => {
  await w.find('input').trigger('focus')
  return w
}

// Sin el “usar «…»” del valor propio: eso no es una entrada del catálogo.
const types = (w: ReturnType<typeof mountPicker>) =>
  w.findAll('.cb-opt:not(.cb-opt--custom) .cb-opt__label').map((e) => e.text())

const chips = (w: ReturnType<typeof mountPicker>) =>
  w.findAll('.cb-chip__text').map((e) => e.text())

const emitted = (w: ReturnType<typeof mountPicker>) => w.emitted('update:modelValue')?.at(-1)?.[0]

describe('EventTypePicker', () => {
  it('lista el catálogo con su descripción', async () => {
    const w = await openList(mountPicker())
    expect(types(w)).toHaveLength(EVENT_CATALOG.length)
    // La descripción es la mitad del valor: `pr.synchronize` no le dice nada a
    // nadie hasta que se lee qué significa.
    expect(w.text()).toContain('Llegaron commits nuevos')
  })

  it('filtra por lo que se está escribiendo', async () => {
    const w = await openList(mountPicker())
    await w.get('input').setValue('pr.')
    expect(types(w).every((t) => t.startsWith('pr.'))).toBe(true)
    expect(types(w).length).toBeGreaterThan(1)
  })

  // El modelo sigue siendo el string separado por comas que la regla persiste;
  // los chips son la lectura de ese string.
  it('lee y escribe la lista separada por comas', async () => {
    const w = await openList(mountPicker('ci.finished'))
    expect(chips(w)).toEqual(['ci.finished'])

    await w.findAll('.cb-opt')[0].trigger('click')
    expect(String(emitted(w))).toMatch(/^ci\.finished, /)
  })

  it('no vuelve a sugerir lo ya elegido', async () => {
    const w = await openList(mountPicker('pr.opened'))
    expect(types(w)).not.toContain('pr.opened')
  })

  // El bus no valida contra el catálogo: un `emit` con un tipo propio, o un
  // evento de otra versión, son configuraciones legítimas.
  it('acepta un tipo que el catálogo no conoce', async () => {
    const w = await openList(mountPicker())
    await w.get('input').setValue('mi.evento.propio')
    expect(types(w)).toHaveLength(0)
    expect(w.text()).toContain('se guarda igual')

    await w.get('.cb-opt--custom').trigger('click')
    expect(emitted(w)).toBe('mi.evento.propio')
  })

  it('quitar un chip lo saca de la lista', async () => {
    const w = mountPicker('pr.opened, ci.finished')
    await w.findAll('.cb-chip__x')[0].trigger('click')
    expect(emitted(w)).toBe('ci.finished')
  })
})
