import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import type { DevProcStatus } from '../api'
import DevProcCard from '../DevProcCard.vue'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, fetchLogs: vi.fn(async () => ['línea 1', 'línea 2']) }
})

function stopped(overrides: Partial<DevProcStatus> = {}): DevProcStatus {
  return {
    id: 'server',
    label: 'Server',
    defaultPort: 3001,
    managed: false,
    portOpen: false,
    mode: null,
    port: null,
    pid: null,
    startedAt: null,
    lastExit: null,
    ...overrides,
  }
}

describe('DevProcCard', () => {
  it('detenido: muestra el label y el botón levantar', () => {
    const wrapper = mount(DevProcCard, { props: { status: stopped() } })
    expect(wrapper.text()).toContain('Server')
    expect(wrapper.find('button.dp-card__logsbtn').exists()).toBe(true)
    const levantar = wrapper.findAll('button').find((b) => b.text() === 'levantar')
    expect(levantar).toBeTruthy()
  })

  it('emite start con el modo y el puerto elegidos', async () => {
    const wrapper = mount(DevProcCard, { props: { status: stopped() } })
    await wrapper.find('input[type="number"]').setValue(4000)
    await wrapper.find('select').setValue('run')
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'levantar')!
      .trigger('click')

    expect(wrapper.emitted('start')?.[0]).toEqual([{ id: 'server', mode: 'run', port: 4000 }])
  })

  it('corriendo (gestionado): muestra detener y no permite editar puerto/modo', async () => {
    const wrapper = mount(DevProcCard, {
      props: {
        status: stopped({ managed: true, portOpen: true, mode: 'dev', port: 3001, pid: 123 }),
      },
    })
    expect(wrapper.find('input[type="number"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('pid 123')

    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('detener'))!
      .trigger('click')
    expect(wrapper.emitted('stop')?.[0]).toEqual(['server'])
  })

  it('corriendo pero externo: no ofrece ninguna acción de arranque/parada', () => {
    const wrapper = mount(DevProcCard, {
      props: { status: stopped({ portOpen: true, port: 3001 }) },
    })
    expect(wrapper.text()).toContain('corriendo (externo)')
    expect(wrapper.findAll('button').find((b) => b.text() === 'levantar')).toBeUndefined()
    expect(wrapper.findAll('button').find((b) => b.text().includes('detener'))).toBeUndefined()
  })

  it('busy deshabilita el botón de acción', () => {
    const wrapper = mount(DevProcCard, { props: { status: stopped(), busy: true } })
    const btn = wrapper.findAll('button').find((b) => b.text().includes('levantando'))
    expect(btn?.attributes('disabled')).toBeDefined()
  })
})
