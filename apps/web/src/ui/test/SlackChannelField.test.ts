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
  it('muestra el NOMBRE en el campo, no el id guardado', async () => {
    // El id es un detalle de almacenamiento (se persiste para que renombrar el
    // canal en Slack no rompa el pedido de review). Lo que el operador lee
    // tiene que ser cómo llama al canal. Y el nombre se resuelve con el
    // desplegable VACÍO, que es el estado real al montar.
    const wrapper = mount(SlackChannelField, { props: { modelValue: 'C0AGHAKPG6T' } })
    await flushPromises()
    expect(lookupChannel).toHaveBeenCalledWith('C0AGHAKPG6T')
    expect(wrapper.get('input').element.value).toBe('#ia-flow-reviews')
  })

  it('deja el id a la vista cuando el bot no puede ver ese canal', async () => {
    // Sin nombre no se inventa nada: el id es lo único cierto.
    const wrapper = mount(SlackChannelField, { props: { modelValue: 'CDESCONOCIDO' } })
    await flushPromises()
    expect(wrapper.get('input').element.value).toBe('CDESCONOCIDO')
  })

  it('vuelve al valor crudo al enfocar, porque es lo que se edita', async () => {
    // Mostrar `#nombre` mientras se tipea mentiría sobre el contenido real del
    // input.
    const wrapper = mount(SlackChannelField, { props: { modelValue: 'C0AGHAKPG6T' } })
    await flushPromises()
    await wrapper.get('input').trigger('focus')
    expect(wrapper.get('input').element.value).toBe('C0AGHAKPG6T')
  })

  it('copia el ID aunque el campo muestre el nombre', async () => {
    // Es el único lugar de donde sale el id, y su único uso real: pegarlo en
    // un runner.yaml o en la API.
    const wrapper = mount(SlackChannelField, { props: { modelValue: 'C0AGHAKPG6T' } })
    await flushPromises()
    expect(wrapper.get('input').element.value).toBe('#ia-flow-reviews')
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
    expect(wrapper.get('input').element.value).toBe('#ia-flow-reviews')
  })

  it('vuelve a resolver cuando el valor cambia desde afuera', async () => {
    const wrapper = mount(SlackChannelField, { props: { modelValue: 'CDESCONOCIDO' } })
    await flushPromises()
    await wrapper.setProps({ modelValue: 'C0AGHAKPG6T' })
    await flushPromises()
    expect(wrapper.get('input').element.value).toBe('#ia-flow-reviews')
  })
})
