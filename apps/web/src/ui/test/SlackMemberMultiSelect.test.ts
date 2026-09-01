import SlackMemberMultiSelect from '@/ui/SlackMemberMultiSelect.vue'
import type { SlackMemberRef } from '@ia-flow/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

const members: SlackMemberRef[] = [
  { id: 'U0GORDO', name: 'gordo' },
  { id: 'B0VITRU', name: 'vitruvio', isBot: true },
  { id: 'USINNOMBRE' },
]

vi.mock('@/composables/useSlackDirectory', () => ({
  useSlackMembers: () => ({
    members: ref(members),
    loading: ref(false),
    failed: ref(false),
    warnings: ref([]),
    search: vi.fn(),
    fetchNow: vi.fn(),
  }),
}))

const writeText = vi.fn(async () => {})

beforeEach(() => {
  writeText.mockClear()
  // happy-dom expone `navigator.clipboard` como getter, así que un
  // `Object.assign` tira — hay que redefinir la propiedad.
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  })
})

function mountWith(selected: SlackMemberRef[]) {
  return mount(SlackMemberMultiSelect, { props: { modelValue: selected } })
}

describe('SlackMemberMultiSelect — identidad de los chips', () => {
  it('muestra el nombre y NO el id — el id sale por el copiar', () => {
    // Imprimir `nombre(ID)` alargaba cada chip con ruido que nadie lee. El id
    // queda en el `title` y, sobre todo, en el botón de copiar.
    const wrapper = mountWith([members[0], members[1]])
    const texts = wrapper.findAll('.cb-chip__text').map((t) => t.text())
    expect(texts).toEqual(['gordo', 'vitruvio'])
    expect(wrapper.get('.cb-chip').attributes('title')).toBe('gordo (U0GORDO)')
  })

  it('cae al id cuando el miembro no tiene nombre', () => {
    const wrapper = mountWith([members[2]])
    expect(wrapper.get('.cb-chip__text').text()).toBe('USINNOMBRE')
  })

  it('copia el id del miembro al portapapeles', async () => {
    const wrapper = mountWith([members[1]])
    await wrapper.get('.copy-btn').trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith('B0VITRU')
  })

  it('copiar no quita el chip', async () => {
    // El botón de copiar vive al lado del de quitar, dentro de un contenedor
    // que enfoca el input al click: sin `@click.stop` un copiado podría
    // arrastrar otro efecto.
    const wrapper = mountWith([members[0]])
    await wrapper.get('.copy-btn').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('un elegido que ya no está en la búsqueda conserva su nombre', async () => {
    // El ComboBox saca la etiqueta del chip de `options`, y `options` es el
    // resultado de la última búsqueda. Sin re-inyectar lo elegido, buscar otra
    // cosa dejaba los chips existentes mostrando el id crudo.
    const wrapper = mountWith([{ id: 'UVIEJO', name: 'alguien' }])
    expect(wrapper.get('.cb-chip__text').text()).toBe('alguien')
  })

  it('el desplegable muestra el id también para los bots', async () => {
    // Antes un bot mostraba sólo la palabra "bot" — justo el caso donde el
    // nombre menos identifica.
    const wrapper = mountWith([])
    await wrapper.get('input').trigger('focus')
    await flushPromises()
    const hints = wrapper.findAll('.cb-opt__hint').map((h) => h.text())
    expect(hints).toContain('bot · B0VITRU')
    expect(hints).toContain('U0GORDO')
  })
})
