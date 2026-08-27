import SlackChannelField from '@/ui/SlackChannelField.vue'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const lookupChannel = vi.fn(async (key: string) =>
  key === 'C0AGHAKPG6T' ? { id: 'C0AGHAKPG6T', name: 'ia-flow-reviews' } : undefined,
)

vi.mock('@/composables/useSlackDirectory', () => ({
  lookupChannel: (key: string) => lookupChannel(key),
  useSlackChannels: () => ({
    // Vacío a propósito: es el estado real al montar, porque el desplegable no
    // se carga hasta que alguien lo abre. Ahí es donde el nombre NO aparecía.
    channels: { value: [] },
    loading: { value: false },
    failed: { value: false },
    warnings: { value: [] },
    search: vi.fn(),
    fetchNow: vi.fn(),
  }),
}))

const writeText = vi.fn(async () => {})

beforeEach(() => {
  lookupChannel.mockClear()
  writeText.mockClear()
  // happy-dom expone `navigator.clipboard` como getter, así que un
  // `Object.assign` tira — hay que redefinir la propiedad.
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  })
})

describe('SlackChannelField — el canal guardado se muestra por su nombre', () => {
  it('resuelve el id a #nombre al montar, con el desplegable sin cargar', async () => {
    // La regresión: `resolvedName` salía de la lista del desplegable, que está
    // vacía hasta el primer foco. El campo mostraba `C0AGHAKPG6T` pelado.
    const wrapper = mount(SlackChannelField, { props: { modelValue: 'C0AGHAKPG6T' } })
    await flushPromises()
    expect(lookupChannel).toHaveBeenCalledWith('C0AGHAKPG6T')
    expect(wrapper.get('.scf-resolved').text()).toBe('#ia-flow-reviews')
  })

  it('deja el id a la vista cuando el bot no puede ver ese canal', async () => {
    // Sin nombre no se inventa nada: el id es lo único cierto.
    const wrapper = mount(SlackChannelField, { props: { modelValue: 'CDESCONOCIDO' } })
    await flushPromises()
    expect(wrapper.find('.scf-resolved').exists()).toBe(false)
    expect(wrapper.get('input').element.value).toBe('CDESCONOCIDO')
  })

  it('copia el id del canal', async () => {
    const wrapper = mount(SlackChannelField, { props: { modelValue: 'C0AGHAKPG6T' } })
    await flushPromises()
    await wrapper.get('.copy-btn').trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith('C0AGHAKPG6T')
  })

  it('no ofrece copiar cuando no hay canal configurado', async () => {
    const wrapper = mount(SlackChannelField, { props: { modelValue: '' } })
    await flushPromises()
    expect(wrapper.find('.copy-btn').exists()).toBe(false)
    expect(lookupChannel).not.toHaveBeenCalled()
  })

  it('no resuelve mientras el campo está enfocado, y una sola vez al soltarlo', async () => {
    // Cada tecla cambia el valor: sin el guard era un GET por pulsación, todos
    // contra ids a medio escribir (y los misses no se cachean a propósito). El
    // nombre además ni se muestra con el campo enfocado.
    vi.useFakeTimers()
    // v-model de verdad: sin devolverle la prop al componente, `modelValue`
    // nunca cambia y el test pasaría sin probar nada.
    const wrapper = mount(SlackChannelField, {
      props: {
        modelValue: '',
        'onUpdate:modelValue': (v: string) => wrapper.setProps({ modelValue: v }),
      },
    })
    const input = wrapper.get('input')
    await input.trigger('focus')
    for (const chunk of ['C0AG', 'C0AGHAK', 'C0AGHAKPG6T']) await input.setValue(chunk)
    await flushPromises()
    expect(lookupChannel).not.toHaveBeenCalled()

    await input.trigger('blur')
    // `onBlur` difiere el cambio de estado para que un click en una sugerencia
    // alcance a dispararse.
    vi.advanceTimersByTime(200)
    vi.useRealTimers()
    await flushPromises()
    expect(lookupChannel).toHaveBeenCalledTimes(1)
    expect(lookupChannel).toHaveBeenCalledWith('C0AGHAKPG6T')
    expect(wrapper.get('.scf-resolved').text()).toBe('#ia-flow-reviews')
  })

  it('vuelve a resolver cuando el valor cambia desde afuera', async () => {
    const wrapper = mount(SlackChannelField, { props: { modelValue: 'CDESCONOCIDO' } })
    await flushPromises()
    await wrapper.setProps({ modelValue: 'C0AGHAKPG6T' })
    await flushPromises()
    expect(wrapper.get('.scf-resolved').text()).toBe('#ia-flow-reviews')
  })
})
