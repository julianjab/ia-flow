import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { item } from './fixtures'

const postTaskAction = vi.fn()
const getInbox = vi.fn()

vi.mock('@/features/inbox/api', () => ({
  postTaskAction: (...a: unknown[]) => postTaskAction(...a),
  getInbox: (...a: unknown[]) => getInbox(...a),
  getTaskDetail: vi.fn(),
}))

import { useGithubSessionStore } from '@/stores/githubSession'
import TaskActions from '../TaskActions.vue'

const merge = item({ kind: 'merge', actions: ['merge'] })
const doubt = item({
  ref: 'acme/api#9',
  kind: 'doubt',
  group: 'need',
  actions: ['answer_and_unblock'],
})
const crash = item({ ref: 'acme/api#8', kind: 'crash', group: 'fail', actions: ['stop', 'retry'] })

function mountActions(it = merge, login = true) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const session = useGithubSessionStore()
  if (login) session.github = { token: 'gho_1', login: 'ada' }
  const wrapper = mount(TaskActions, { props: { item: it }, global: { plugins: [pinia] } })
  return { wrapper, session }
}

describe('TaskActions', () => {
  beforeEach(() => {
    localStorage.clear()
    postTaskAction.mockReset()
    getInbox.mockReset().mockResolvedValue({ generated_at: 'x', projects: [], items: [] })
  })

  it('una card sin acciones no dibuja nada', () => {
    const { wrapper } = mountActions(item({ actions: [] }))
    expect(wrapper.find('.ta').exists()).toBe(false)
  })

  it('cada acción de item.actions es un botón con su nombre; la principal es primary', () => {
    const { wrapper } = mountActions(crash)
    const buttons = wrapper.findAll('[data-action]')
    // neutro → primario → peligroso: el `retry` primario antes que el `stop`.
    expect(buttons.map((b) => b.attributes('data-action'))).toEqual(['retry', 'stop'])
    expect(buttons[0]?.classes()).toContain('btn--primary')
    expect(buttons[1]?.classes()).toContain('btn--danger')
    expect(wrapper.text()).toContain('Reintentar')
  })

  it('confirma en la página y sólo entonces manda la acción con el token del usuario', async () => {
    postTaskAction.mockResolvedValue({ ok: true, message: 'PR mergeado', github_login: 'ada' })
    const { wrapper } = mountActions()

    await wrapper.find('[data-action="merge"]').trigger('click')
    expect(postTaskAction).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('¿Mergear el PR de acme/api#7?')

    await wrapper.find('[data-test="confirm"]').trigger('click')
    await flushPromises()
    expect(postTaskAction).toHaveBeenCalledWith('acme/api#7', { action: 'merge' }, 'gho_1')
    expect(wrapper.text()).toContain('✓ PR mergeado')
    expect(wrapper.text()).toContain('@ada')
  })

  it('cancelar la confirmación no manda nada', async () => {
    const { wrapper } = mountActions()
    await wrapper.find('[data-action="merge"]').trigger('click')
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Cancelar')
      ?.trigger('click')
    expect(wrapper.find('[data-test="confirm"]').exists()).toBe(false)
    expect(postTaskAction).not.toHaveBeenCalled()
  })

  it('sin login de GitHub NO manda la request: pide iniciar sesión', async () => {
    const { wrapper, session } = mountActions(merge, false)
    await wrapper.find('[data-action="merge"]').trigger('click')

    expect(postTaskAction).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('Iniciá sesión con GitHub')
    await wrapper.find('[data-test="login"]').trigger('click')
    expect(session.loginOpen).toBe(true)
  })

  it('responder y destrabar exige el comentario y lo manda', async () => {
    postTaskAction.mockResolvedValue({ ok: true, message: 'Comentado' })
    const { wrapper } = mountActions(doubt)
    const button = wrapper.find('[data-action="answer_and_unblock"]')
    expect(button.attributes('disabled')).toBeDefined()

    await wrapper.find('textarea').setValue('  Son 90 días  ')
    expect(button.attributes('disabled')).toBeUndefined()
    await button.trigger('click')
    await wrapper.find('[data-test="confirm"]').trigger('click')
    await flushPromises()

    expect(postTaskAction).toHaveBeenCalledWith(
      'acme/api#9',
      { action: 'answer_and_unblock', comment: 'Son 90 días' },
      'gho_1',
    )
    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('')
  })

  it('un rechazo del runner se muestra como error de la card', async () => {
    postTaskAction.mockResolvedValue({ ok: false, message: 'La tarea cambió' })
    const { wrapper } = mountActions()
    await wrapper.find('[data-action="merge"]').trigger('click')
    await wrapper.find('[data-test="confirm"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="alert"]').text()).toContain('✕ La tarea cambió')
  })
  it('una acción que declaró el proyecto trae su etiqueta, su comentario y su confirmación', async () => {
    postTaskAction.mockResolvedValue({ ok: true, message: 'listo', github_login: 'ada' })
    const declared = item({
      ref: 'acme/api#7',
      kind: 'prerequisite',
      group: 'need',
      actions: ['chain_behind', 'approve_prd'],
      action_defs: [
        {
          id: 'chain_behind',
          label: 'Encadenarla detrás de otra',
          comment: 'required',
          confirm: '¿Bloquearla por la que indicaste?',
        },
      ],
    })
    const { wrapper } = mountActions(declared)

    // La declarada se nombra como dice el proyecto; la del runner, como siempre.
    expect(wrapper.find('[data-action="chain_behind"]').text()).toBe('Encadenarla detrás de otra')
    expect(wrapper.find('[data-action="approve_prd"]').text()).toBe('Aprobar y pasar a Build')

    // Pide comentario sólo para la que lo declara.
    expect(wrapper.find('[data-action="chain_behind"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-action="approve_prd"]').attributes('disabled')).toBeUndefined()

    await wrapper.find('textarea').setValue('#1578')
    await wrapper.find('[data-action="chain_behind"]').trigger('click')
    expect(wrapper.find('.ta__ask').text()).toBe('¿Bloquearla por la que indicaste?')
    await wrapper.find('[data-test="confirm"]').trigger('click')
    await flushPromises()

    expect(postTaskAction).toHaveBeenCalledWith(
      'acme/api#7',
      { action: 'chain_behind', comment: '#1578' },
      'gho_1',
    )
  })
})
