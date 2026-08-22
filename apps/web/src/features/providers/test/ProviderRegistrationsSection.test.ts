import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRegistration } from '../registrations-api'

const listMock = vi.fn<[], Promise<ProviderRegistration[]>>()
const createMock = vi.fn()
const deleteMock = vi.fn()
vi.mock('../registrations-api', () => ({
  listProviderRegistrations: () => listMock(),
  createProviderRegistration: (input: unknown) => createMock(input),
  deleteProviderRegistration: (id: string) => deleteMock(id),
}))

import ProviderRegistrationsSection from '../ProviderRegistrationsSection.vue'

function makeReg(overrides: Partial<ProviderRegistration> = {}): ProviderRegistration {
  return {
    id: 'julianbuitrago-mac',
    name: 'julianbuitrago-mac',
    baseUrl: 'http://host.containers.internal:3002',
    remoteKind: 'sync',
    remoteName: 'Claude API (headless)',
    remoteDescription: 'Direct fetch to Anthropic API.',
    createdAt: '2026-01-01T00:00:00Z',
    hasToken: true,
    ...overrides,
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  listMock.mockReset()
  createMock.mockReset()
  deleteMock.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ProviderRegistrationsSection', () => {
  it('carga y muestra las registraciones al montar', async () => {
    listMock.mockResolvedValueOnce([makeReg()])
    const wrapper = mount(ProviderRegistrationsSection)
    await flushPromises()

    expect(listMock).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('remote:julianbuitrago-mac')
    expect(wrapper.text()).toContain('Claude API (headless)')
    expect(wrapper.text()).toContain('token configurado')
  })

  it('muestra el estado vacío cuando no hay registraciones', async () => {
    listMock.mockResolvedValueOnce([])
    const wrapper = mount(ProviderRegistrationsSection)
    await flushPromises()

    expect(wrapper.text()).toContain('Sin providers remotos registrados todavía.')
  })

  it('marca el token faltante explícitamente', async () => {
    listMock.mockResolvedValueOnce([makeReg({ hasToken: false })])
    const wrapper = mount(ProviderRegistrationsSection)
    await flushPromises()

    expect(wrapper.text()).toContain('token FALTA')
  })

  it('abre el formulario, valida campos requeridos, y crea una registración', async () => {
    listMock.mockResolvedValueOnce([])
    createMock.mockResolvedValueOnce(makeReg())
    listMock.mockResolvedValueOnce([makeReg()])

    const wrapper = mount(ProviderRegistrationsSection)
    await flushPromises()

    await wrapper.find('button.btn-primary').trigger('click')
    expect(wrapper.find('.editor').exists()).toBe(true)

    // Sin completar nada: no llama al API, no cierra el editor.
    await wrapper.find('.editor .btn-primary').trigger('click')
    await flushPromises()
    expect(createMock).not.toHaveBeenCalled()
    expect(wrapper.find('.editor').exists()).toBe(true)

    const inputs = wrapper.findAll('.editor input')
    await inputs[0]!.setValue('julianbuitrago-mac')
    await inputs[1]!.setValue('http://host.containers.internal:3002')
    await inputs[2]!.setValue('secret-token')

    await wrapper.find('.editor .btn-primary').trigger('click')
    await flushPromises()

    expect(createMock).toHaveBeenCalledWith({
      name: 'julianbuitrago-mac',
      baseUrl: 'http://host.containers.internal:3002',
      token: 'secret-token',
    })
    expect(listMock).toHaveBeenCalledTimes(2)
    expect(wrapper.find('.editor').exists()).toBe(false)
  })

  it('cancelar cierra el formulario sin llamar al API', async () => {
    listMock.mockResolvedValueOnce([])
    const wrapper = mount(ProviderRegistrationsSection)
    await flushPromises()

    await wrapper.find('button.btn-primary').trigger('click')
    expect(wrapper.find('.editor').exists()).toBe(true)

    await wrapper.find('.editor .btn-secondary').trigger('click')
    expect(wrapper.find('.editor').exists()).toBe(false)
    expect(createMock).not.toHaveBeenCalled()
  })

  it('pide confirmación y elimina una registración', async () => {
    listMock.mockResolvedValueOnce([makeReg()])
    deleteMock.mockResolvedValueOnce(undefined)
    listMock.mockResolvedValueOnce([])
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    )

    const wrapper = mount(ProviderRegistrationsSection)
    await flushPromises()

    await wrapper.find('.btn-danger').trigger('click')
    await flushPromises()

    expect(confirm).toHaveBeenCalledWith(
      "¿Eliminar la registración 'julianbuitrago-mac'? Cualquier agente con provider: remote:julianbuitrago-mac dejará de poder despachar.",
    )
    expect(deleteMock).toHaveBeenCalledWith('julianbuitrago-mac')
    expect(listMock).toHaveBeenCalledTimes(2)
  })

  it('no elimina si el usuario cancela la confirmación', async () => {
    listMock.mockResolvedValueOnce([makeReg()])
    vi.stubGlobal(
      'confirm',
      vi.fn(() => false),
    )

    const wrapper = mount(ProviderRegistrationsSection)
    await flushPromises()

    await wrapper.find('.btn-danger').trigger('click')
    await flushPromises()

    expect(deleteMock).not.toHaveBeenCalled()
  })
})
