import type { Project } from '@ia-flow/shared'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ProjectProviderTab from '../tabs/ProjectProviderTab.vue'

// El tab pide el catálogo de campos para el form de la fuente (la marca de
// "agente trabajando" se elige de ahí, no se escribe a mano).
vi.mock('@/features/projects/sourceApi', () => ({
  fetchProjectFields: vi.fn(async () => ({ kind: 'local', fields: [] })),
}))

vi.mock('@/features/projects/api', () => ({
  fetchProjectsMeta: vi.fn(async () => ({
    sourceKinds: ['github', 'local'],
    daemonModes: ['webhook', 'polling'],
    daemonModeFallback: 'webhook',
  })),
}))

function project(settings: Record<string, unknown> = {}): Project {
  return { id: 'p1', name: 'p1', source: { kind: 'local', config: {} }, settings } as Project
}

const capInput = (wrapper: ReturnType<typeof mount>) =>
  wrapper.findAll('input[type="number"]').at(-1)!

describe('ProjectProviderTab', () => {
  beforeEach(() => setActivePinia(createPinia()))

  // Regresión: el watch de hidratación es `immediate`, así que corre durante
  // el setup. Leer desde ahí un `const` declarado más abajo en el <script
  // setup> revienta con "cannot access before initialization" y el tab entero
  // queda en blanco. Montarlo es lo único que lo detecta.
  it('monta sin explotar cuando el proyecto ya trae settings', () => {
    expect(() => mount(ProjectProviderTab, { props: { project: project() } })).not.toThrow()
  })

  it('hidrata el cap guardado del proyecto', () => {
    const wrapper = mount(ProjectProviderTab, {
      props: { project: project({ maxConcurrentDispatches: 3 }) },
    })
    expect(capInput(wrapper).element.value).toBe('3')
  })

  it('sin cap guardado muestra el campo vacío (= heredar el global)', () => {
    const wrapper = mount(ProjectProviderTab, { props: { project: project() } })
    expect(capInput(wrapper).element.value).toBe('')
    expect(wrapper.text()).toContain('Heredar el default global')
  })

  it('el botón de guardar se habilita al tocar el cap', async () => {
    const wrapper = mount(ProjectProviderTab, { props: { project: project() } })
    const save = wrapper.get('.ppt-btn--primary')
    expect(save.attributes('disabled')).toBeDefined()

    await capInput(wrapper).setValue('4')
    expect(save.attributes('disabled')).toBeUndefined()
  })

  it('hidrata las condiciones base guardadas del proyecto', () => {
    const wrapper = mount(ProjectProviderTab, {
      props: { project: project({ baseWhen: [{ field: 'labels', op: '!=', value: 'blocked' }] }) },
    })
    const fieldInputs = wrapper.findAll('.ppt-basewhen input')
    expect(fieldInputs.some((i) => (i.element as HTMLInputElement).value === 'labels')).toBe(true)
  })

  it('sin condiciones base guardadas, el editor arranca vacío', () => {
    const wrapper = mount(ProjectProviderTab, { props: { project: project() } })
    expect(wrapper.get('.ppt-basewhen').findAll('.cre-cell--field')).toHaveLength(0)
  })

  it('el botón de guardar se habilita al agregar una condición base', async () => {
    const wrapper = mount(ProjectProviderTab, { props: { project: project() } })
    const save = wrapper.get('.ppt-btn--primary')
    expect(save.attributes('disabled')).toBeDefined()

    const addBtn = wrapper
      .get('.ppt-basewhen')
      .findAll('button')
      .find((b) => /agregar|\+/i.test(b.text()))
    expect(addBtn).toBeDefined()
    await addBtn!.trigger('click')
    await wrapper.get('.ppt-basewhen').get('.cre-cell--field input').setValue('labels')
    expect(save.attributes('disabled')).toBeUndefined()
  })
})
