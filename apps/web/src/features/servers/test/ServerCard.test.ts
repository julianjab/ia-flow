import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { ProbedServer } from '../api'
import ServerCard from '../ServerCard.vue'

function probed(overrides: Partial<ProbedServer> = {}): ProbedServer {
  return {
    baseUrl: 'http://localhost:3011',
    kind: 'runner',
    reachable: true,
    needsToken: false,
    latencyMs: 12.4,
    projects: [{ id: 'core', board: { owner: 'acme', number: 7 } }],
    version: '2.0.0',
    deviceFlow: true,
    assistant: true,
    ...overrides,
  }
}

const mountCard = (server: ProbedServer, extra: Record<string, unknown> = {}) =>
  mount(ServerCard, { props: { server, current: false, ...extra } })

describe('ServerCard', () => {
  it('un runner muestra su versión, sus proyectos y la latencia', () => {
    const text = mountCard(probed()).text()
    expect(text).toContain('runner 2.0.0')
    expect(text).toContain('core')
    expect(text).toContain('acme#7')
    expect(text).toContain('12 ms')
  })

  it('el server elegido se marca y no se puede quitar', () => {
    const wrapper = mountCard(probed(), { current: true })
    expect(wrapper.text()).toContain('estás acá')
    expect(wrapper.find('[aria-label="Quitar de la lista"]').exists()).toBe(false)
  })

  it('entrar emite la baseUrl; caído, el botón está deshabilitado', async () => {
    const wrapper = mountCard(probed())
    await wrapper.find('.card__enter').trigger('click')
    expect(wrapper.emitted('enter')?.[0]).toEqual(['http://localhost:3011'])

    const down = mountCard(probed({ reachable: false }))
    expect(down.find('.card__enter').attributes('disabled')).toBeDefined()
    expect(down.text()).toContain('no responde')
  })

  it('un 401 se dice distinto de "no responde" y abre el campo del token', () => {
    const wrapper = mountCard(probed({ reachable: false, needsToken: true, kind: 'unknown' }))
    expect(wrapper.text()).toContain('pide token')
    expect(wrapper.find('input[type="password"]').exists()).toBe(true)
  })

  it('algo que no es un runner lo dice', () => {
    expect(mountCard(probed({ kind: 'unknown' })).text()).toContain('no es un runner-v2')
  })

  it('guardar el token emite el valor recortado', async () => {
    const wrapper = mountCard(probed({ reachable: false, needsToken: true, kind: 'unknown' }))
    await wrapper.find('input').setValue('  secreto ')
    await wrapper.find('form').trigger('submit')
    expect(wrapper.emitted('token')?.[0]).toEqual([
      { baseUrl: 'http://localhost:3011', token: 'secreto' },
    ])
  })

  it('con login de GitHub muestra el usuario y permite cerrar sesión; sin él lo dice', async () => {
    const withLogin = mountCard(probed(), { github: { login: 'ada' } })
    expect(withLogin.text()).toContain('@ada')
    await withLogin.find('.card__ghbtn').trigger('click')
    expect(withLogin.emitted('github-logout')?.[0]).toEqual(['http://localhost:3011'])

    expect(mountCard(probed()).text()).toContain('sin sesión de GitHub')
  })
})
