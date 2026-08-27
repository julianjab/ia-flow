import CopyButton from '@/ui/CopyButton.vue'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const writeText = vi.fn(async () => {})

function setClipboard(value: unknown) {
  // happy-dom expone `navigator.clipboard` como getter, así que un
  // `Object.assign` tira — hay que redefinir la propiedad.
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true })
}

beforeEach(() => {
  writeText.mockClear()
  vi.useFakeTimers()
  setClipboard({ writeText })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('CopyButton', () => {
  it('copia el valor y confirma', async () => {
    const wrapper = mount(CopyButton, { props: { value: 'U0GORDO' } })
    expect(wrapper.text()).toBe('⧉')
    await wrapper.get('button').trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith('U0GORDO')
    expect(wrapper.text()).toBe('✓')
  })

  it('vuelve al estado inicial pasado el feedback', async () => {
    const wrapper = mount(CopyButton, { props: { value: 'U0GORDO' } })
    await wrapper.get('button').trigger('click')
    await flushPromises()
    vi.advanceTimersByTime(1200)
    await flushPromises()
    expect(wrapper.text()).toBe('⧉')
  })

  it('NO confirma cuando no hay portapapeles', async () => {
    // Fuera de un contexto seguro `navigator.clipboard` es undefined. Con
    // `navigator.clipboard?.writeText(...)` el optional chaining resolvía a
    // `undefined` sin lanzar, el catch no corría y el botón mostraba ✓ con el
    // portapapeles vacío — mentirle al usuario sobre un copiado es peor que no
    // ofrecerlo.
    setClipboard(undefined)
    const wrapper = mount(CopyButton, { props: { value: 'U0GORDO' } })
    await wrapper.get('button').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toBe('⧉')
  })

  it('tampoco confirma si el navegador rechaza el permiso', async () => {
    setClipboard({
      writeText: vi.fn(async () => {
        throw new Error('NotAllowedError')
      }),
    })
    const wrapper = mount(CopyButton, { props: { value: 'U0GORDO' } })
    await wrapper.get('button').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toBe('⧉')
  })

  it('es type=button — no envía el formulario que lo contiene', () => {
    // Vive dentro de los editores de repo y de proyecto, que son <form>.
    const wrapper = mount(CopyButton, { props: { value: 'x' } })
    expect(wrapper.get('button').attributes('type')).toBe('button')
  })
})
