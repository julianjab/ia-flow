import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'
import { useGithubSessionStore } from '@/stores/githubSession'
import ImprovementCard from '../ImprovementCard.vue'
import { proposal } from './fixtures'

function card(props: Record<string, unknown>, login = true) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const session = useGithubSessionStore()
  session.github = login ? { token: 'gho_1', login: 'ada' } : null
  return { wrapper: mount(ImprovementCard, { props, global: { plugins: [pinia] } }), session }
}

describe('ImprovementCard', () => {
  it('muestra título, destino, repo, tarea, PR, motivo y el cuerpo plegado', () => {
    const { wrapper } = card({ proposal: proposal() })
    expect(wrapper.get('[data-test="title"]').text()).toBe('Documentar el comando de tests')
    expect(wrapper.get('[data-test="target"]').text()).toBe('Docs del repo')
    expect(wrapper.get('[data-test="repo"]').text()).toBe('acme/api')
    expect(wrapper.get('[data-test="pr"]').attributes('href')).toBe(
      'https://github.com/acme/api/pull/9',
    )
    expect(wrapper.text()).toContain('el agente adivinó el comando')
    expect(wrapper.get('[data-test="body"]').text()).toContain('Nadie sabe')
    expect(wrapper.get('details').attributes('open')).toBeUndefined()
  })

  it('nombra el destino config y engine', () => {
    expect(
      card({ proposal: proposal({ target: 'config' }) })
        .wrapper.get('[data-test="target"]')
        .text(),
    ).toBe('Config del runner')
    expect(
      card({ proposal: proposal({ target: 'engine' }) })
        .wrapper.get('[data-test="target"]')
        .text(),
    ).toBe('Engine')
  })

  it('la tarea de origen emite open con su ref', async () => {
    const { wrapper } = card({ proposal: proposal() })
    await wrapper.get('[data-test="task"]').trigger('click')
    expect(wrapper.emitted('open')?.[0]).toEqual(['acme/api#7'])
  })

  it('Abrir issue y Descartar emiten', async () => {
    const { wrapper } = card({ proposal: proposal() })
    await wrapper.get('[data-test="run"]').trigger('click')
    await wrapper.get('[data-test="dismiss"]').trigger('click')
    expect(wrapper.emitted('run')).toHaveLength(1)
    expect(wrapper.emitted('dismiss')).toHaveLength(1)
  })

  it('sin login el botón pide el login y no emite run', async () => {
    const { wrapper, session } = card({ proposal: proposal() }, false)
    expect(wrapper.find('[data-test="run"]').exists()).toBe(false)
    await wrapper.get('[data-test="login"]').trigger('click')
    expect(session.loginOpen).toBe(true)
    expect(wrapper.emitted('run')).toBeUndefined()
  })

  it('running deshabilita los botones', () => {
    const { wrapper } = card({ proposal: proposal(), state: { status: 'running' } })
    expect(wrapper.get('[data-test="run"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-test="run"]').text()).toBe('Abriendo…')
    expect(wrapper.get('[data-test="dismiss"]').attributes('disabled')).toBeDefined()
  })

  it('un error muestra el mensaje y deja los botones', () => {
    const { wrapper } = card({
      proposal: proposal(),
      state: { status: 'error', message: 'sin permisos' },
    })
    expect(wrapper.get('[role="alert"]').text()).toContain('sin permisos')
    expect(wrapper.find('[data-test="run"]').exists()).toBe(true)
  })

  it('abierta, linkea al issue y no ofrece decidir', () => {
    const { wrapper } = card({
      proposal: proposal({ status: 'opened' }),
      state: { status: 'done', message: 'acme/api#1', url: 'https://github.com/acme/api/issues/1' },
    })
    expect(wrapper.get('[data-test="issue"]').attributes('href')).toBe(
      'https://github.com/acme/api/issues/1',
    )
    expect(wrapper.find('[data-test="run"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="dismiss"]').exists()).toBe(false)
  })
})
