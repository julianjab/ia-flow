import SlackChannelField from '@/ui/SlackChannelField.vue'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

const lookupChannel = vi.fn(async (key: string) =>
  key === 'C0AGHAKPG6T' ? { id: 'C0AGHAKPG6T', name: 'ia-flow-reviews' } : undefined,
)

const fetchNow = vi.fn()
const search = vi.fn()

vi.mock('@/composables/useSlackDirectory', () => ({
  lookupChannel: (key: string) => lookupChannel(key),
  useSlackChannels: () => ({
    // Vacío a propósito: es el estado real al montar, porque el desplegable no
    // se carga hasta que alguien lo abre. Ahí es donde el nombre NO aparecía.
    channels: ref([]),
    loading: ref(false),
    failed: ref(false),
    warnings: ref([]),
    search,
    fetchNow,
  }),
}))

const writeText = vi.fn(async () => {})

beforeEach(() => {
  lookupChannel.mockClear()
  fetchNow.mockClear()
  writeText.mockClear()
  // happy-dom expone `navigator.clipboard` como getter, así que un
  // `Object.assign` tira — hay que redefinir la propiedad.
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  })
})

const mk = (modelValue: string) => mount(SlackChannelField, { props: { modelValue } })

describe('SlackChannelField — el canal guardado se muestra por su nombre', () => {
  it('muestra el NOMBRE en el chip, no el id guardado', async () => {
    // El id es un detalle de almacenamiento (se persiste para que renombrar el
    // canal en Slack no rompa el pedido de review). Lo que el operador lee
    // tiene que ser cómo llama al canal. Y el nombre se resuelve con el
    // desplegable VACÍO, que es el estado real al montar.
    const w = mk('C0AGHAKPG6T')
    await flushPromises()
    expect(lookupChannel).toHaveBeenCalledWith('C0AGHAKPG6T')
    expect(w.get('.cb-chip__text').text()).toBe('#ia-flow-reviews')
  })

  it('deja el id a la vista cuando el bot no puede ver ese canal', async () => {
    // Sin nombre no se inventa nada: el id es lo único cierto.
    const w = mk('CDESCONOCIDO')
    await flushPromises()
    expect(w.get('.cb-chip__text').text()).toBe('CDESCONOCIDO')
  })

  it('copia el ID aunque el chip muestre el nombre', async () => {
    // Es el único lugar de donde sale el id, y su único uso real: pegarlo en
    // un runner.yaml o en la API.
    const w = mk('C0AGHAKPG6T')
    await flushPromises()
    await w.get('.copy-btn').trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith('C0AGHAKPG6T')
  })

  it('no ofrece copiar cuando no hay canal configurado', async () => {
    const w = mk('')
    await flushPromises()
    expect(w.find('.copy-btn').exists()).toBe(false)
    expect(lookupChannel).not.toHaveBeenCalled()
  })

  // El guard contra el foco que esto tenía ya no hace falta: el ComboBox se
  // queda con lo que se tipea y sólo emite al confirmar, así que un id a medio
  // escribir nunca llega hasta acá.
  it('resuelve una vez por valor, no por tecla', async () => {
    const w = mk('')
    await flushPromises()
    await w.setProps({ modelValue: 'C0AGHAKPG6T' })
    await flushPromises()
    expect(lookupChannel).toHaveBeenCalledTimes(1)
    expect(w.get('.cb-chip__text').text()).toBe('#ia-flow-reviews')
  })

  it('acepta un id que el bot no lista, porque la lista no es el workspace', async () => {
    // `conversations.list` sólo devuelve los canales donde la app está
    // instalada. Si el campo no aceptara texto libre, un canal privado sería
    // inconfigurable.
    const w = mk('')
    await w.get('input').trigger('focus')
    await w.get('input').setValue('C0PRIVADO')
    await w.get('input').trigger('blur')
    expect(w.emitted('update:modelValue')?.at(-1)).toEqual(['C0PRIVADO'])
  })

  it('abrir el desplegable pide la lista', async () => {
    const w = mk('')
    await w.get('input').trigger('focus')
    expect(fetchNow).toHaveBeenCalled()
  })
})
