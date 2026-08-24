import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ServerCard from '../ServerCard.vue'
import type { ProbedServer } from '../api'

function probed(overrides: Partial<ProbedServer> = {}): ProbedServer {
  return {
    baseUrl: 'http://localhost:3011',
    reachable: true,
    latencyMs: 12.4,
    projects: [],
    remoteProviders: [],
    ...overrides,
  }
}

describe('ServerCard', () => {
  it('cuenta como activos sólo los proyectos sin polling pausado', () => {
    const wrapper = mount(ServerCard, {
      props: {
        server: probed({
          projects: [
            { id: 'a', name: 'A', settings: { pollingPaused: true } },
            { id: 'b', name: 'B', settings: {} },
            { id: 'c', name: 'C' },
          ] as ProbedServer['projects'],
        }),
        current: false,
        pinned: false,
      },
    })
    expect(wrapper.text()).toContain('2 / 3')
  })

  it('un server que no responde no muestra stats — no hay nada que contar', () => {
    const wrapper = mount(ServerCard, {
      props: { server: probed({ reachable: false }), current: false, pinned: false },
    })
    expect(wrapper.text()).toContain('no responde')
    expect(wrapper.text()).not.toContain('latencia')
  })

  it('marca el server que esta web está mirando', () => {
    const wrapper = mount(ServerCard, {
      props: { server: probed(), current: true, pinned: false },
    })
    expect(wrapper.text()).toContain('estás acá')
  })

  it('el actual no se puede quitar aunque esté pineado — te dejaría sin nada', () => {
    const wrapper = mount(ServerCard, {
      props: { server: probed(), current: true, pinned: true },
    })
    expect(wrapper.find('.card__x').exists()).toBe(false)
  })

  it('quitar un server pineado emite su baseUrl', async () => {
    const wrapper = mount(ServerCard, {
      props: { server: probed(), current: false, pinned: true },
    })
    await wrapper.get('.card__x').trigger('click')
    expect(wrapper.emitted('remove')?.at(-1)).toEqual(['http://localhost:3011'])
  })
})
