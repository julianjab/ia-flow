import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ServerCard from '../ServerCard.vue'
import type { ProbedServer } from '../api'

function probed(overrides: Partial<ProbedServer> = {}): ProbedServer {
  return {
    baseUrl: 'http://localhost:3011',
    kind: 'server',
    reachable: true,
    needsToken: false,
    latencyMs: 12.4,
    projects: [],
    remoteProviders: [],
    agentHost: null,
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

  it('un click en cualquier parte de la tarjeta entra al server', async () => {
    // El botón se estira sobre la tarjeta con un `::after`, así que el área
    // clickeable es toda ella y no sólo el texto de la URL.
    const wrapper = mount(ServerCard, {
      props: { server: probed(), current: false },
    })

    await wrapper.get('.card__enter').trigger('click')

    expect(wrapper.emitted('enter')?.[0]).toEqual(['http://localhost:3011'])
  })

  it('un server que no responde no deja entrar', async () => {
    const wrapper = mount(ServerCard, {
      props: { server: probed({ reachable: false }), current: false },
    })

    expect(wrapper.get('.card__enter').attributes('disabled')).toBeDefined()
  })

  it('el campo del token sigue usable en un server que pide token', async () => {
    // El caso que rompía cuando la tarjeta entera era un `<button :disabled>`:
    // el navegador no despacha clicks a los descendientes de un botón
    // deshabilitado, así que el arreglo quedaba fuera de alcance.
    const wrapper = mount(ServerCard, {
      props: { server: probed({ reachable: false, needsToken: true }), current: false },
    })

    const input = wrapper.get('input[type="password"]')
    await input.setValue('mi-token')
    await wrapper.get('.card__tokenform').trigger('submit')

    expect(wrapper.emitted('token')?.[0]).toEqual([
      { baseUrl: 'http://localhost:3011', token: 'mi-token' },
    ])
  })

  it('un agent-host muestra su provider y su ocupación, no proyectos', () => {
    // Un agent-host no tiene proyectos ni registraciones. Mostrarle las stats
    // de un server le pondría tres ceros que no significan nada.
    const wrapper = mount(ServerCard, {
      props: {
        server: probed({
          kind: 'agent-host',
          agentHost: {
            providerId: 'anthropic-api',
            providerName: 'Anthropic API',
            running: 1,
            maxConcurrentRuns: 3,
            accepting: true,
          },
        }),
        current: false,
      },
    })

    expect(wrapper.text()).toContain('agent-host')
    expect(wrapper.text()).toContain('Anthropic API')
    expect(wrapper.text()).toContain('1 / 3')
    expect(wrapper.text()).not.toContain('proyectos')
  })

  it('un agent-host sin cap declarado no inventa un límite', () => {
    // `null` es "sin límite" en todo el engine; un "0" ahí diría lo contrario.
    const wrapper = mount(ServerCard, {
      props: {
        server: probed({
          kind: 'agent-host',
          agentHost: {
            providerId: 'x',
            providerName: 'X',
            running: 2,
            maxConcurrentRuns: null,
            accepting: true,
          },
        }),
        current: false,
      },
    })

    expect(wrapper.text()).not.toContain('/ 0')
  })

  it('un agent-host que pide token se identifica igual', () => {
    // Es la pista de en qué pantalla está el arreglo, y hace falta justo
    // cuando la credencial no alcanza para averiguarlo de otra forma.
    const wrapper = mount(ServerCard, {
      props: {
        server: probed({ kind: 'agent-host', reachable: false, needsToken: true }),
        current: false,
      },
    })

    expect(wrapper.text()).toContain('agent-host')
    expect(wrapper.text()).toContain('pide token')
  })

  it('quitar emite la baseUrl — el confirmar lo hace la pantalla', async () => {
    const wrapper = mount(ServerCard, {
      props: { server: probed({ reachable: false }), current: false },
    })

    await wrapper.get('.card__x').trigger('click')

    // La tarjeta no borra: avisa. Quién confirma es ServerPickerView, que es
    // donde vive el diálogo.
    expect(wrapper.emitted('remove')?.[0]).toEqual(['http://localhost:3011'])
  })
})
