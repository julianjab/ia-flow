import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { item } from '@/features/inbox/test/fixtures'

const postTaskAction = vi.fn()
const getInbox = vi.fn()

vi.mock('@/features/inbox/api', () => ({
  postTaskAction: (...a: unknown[]) => postTaskAction(...a),
  getInbox: (...a: unknown[]) => getInbox(...a),
  getTasks: vi.fn().mockResolvedValue(null),
  getTaskDetail: vi.fn(),
}))

import TaskActions from '@/features/inbox/TaskActions.vue'
import { useGithubSessionStore } from '@/stores/githubSession'

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

const button = (w: ReturnType<typeof mountActions>['wrapper'], id: string) =>
  w.get(`[data-action="${id}"] button`)

describe('TaskActions (el panel de detalle)', () => {
  beforeEach(() => {
    localStorage.clear()
    postTaskAction.mockReset()
    getInbox.mockReset().mockResolvedValue({ generated_at: 'x', projects: [], items: [] })
  })

  it('una card sin acciones no dibuja nada', () => {
    const { wrapper } = mountActions(item({ actions: [] }))
    expect(wrapper.find('.ta').exists()).toBe(false)
  })

  it('la principal primero y «Detener…» al final, en contorno danger; ninguna primaria', () => {
    const { wrapper } = mountActions(crash)
    const ids = wrapper.findAll('[data-action]').map((b) => b.attributes('data-action'))
    expect(ids).toEqual(['retry', 'stop'])
    expect(wrapper.find('.btn--primary').exists()).toBe(false)
    expect(button(wrapper, 'retry').text()).toBe('Reintentar')
    expect(button(wrapper, 'stop').text()).toBe('Detener…')
    expect(button(wrapper, 'stop').classes()).toContain('btn--danger')
    expect(button(wrapper, 'retry').classes()).not.toContain('btn--danger')
  })

  it('la confirmación de «Detener…» también ejecuta con un botón danger', async () => {
    const { wrapper } = mountActions(crash)
    await button(wrapper, 'stop').trigger('click')
    const run = wrapper.get('[data-test="inline-confirm"] [data-test="confirm"]')
    expect(run.text()).toBe('Detener ahora')
    expect(run.classes()).toContain('btn--danger')
    expect(postTaskAction).not.toHaveBeenCalled()
  })

  it('Reintentar no confirma: manda la acción directo con tu token', async () => {
    postTaskAction.mockResolvedValue({ ok: true, message: 'Relanzada' })
    const { wrapper } = mountActions(crash)
    await button(wrapper, 'retry').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="inline-confirm"]').exists()).toBe(false)
    expect(postTaskAction).toHaveBeenCalledWith('acme/api#8', { action: 'retry' }, 'gho_1')
  })

  it('mergear confirma en línea —qué, dónde y con tu usuario— y «Mergear ahora» lo manda', async () => {
    postTaskAction.mockResolvedValue({ ok: true, message: 'PR mergeado', github_login: 'ada' })
    const { wrapper } = mountActions()

    await button(wrapper, 'merge').trigger('click')
    expect(postTaskAction).not.toHaveBeenCalled()
    const confirm = wrapper.get('[data-test="inline-confirm"]')
    expect(confirm.text()).toContain('api#7')
    expect(confirm.text()).toContain('tu usuario de GitHub (@ada)')
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false)
    expect(wrapper.get('[data-test="confirm"]').text()).toBe('Mergear ahora')

    await wrapper.get('[data-test="confirm"]').trigger('click')
    await flushPromises()
    expect(postTaskAction).toHaveBeenCalledWith('acme/api#7', { action: 'merge' }, 'gho_1')
    expect(wrapper.get('[role="status"]').text()).toContain('✓ PR mergeado · @ada')
  })

  it('cancelar la confirmación no manda nada y vuelve el botón', async () => {
    const { wrapper } = mountActions()
    await button(wrapper, 'merge').trigger('click')
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Cancelar')
      ?.trigger('click')
    expect(wrapper.find('[data-test="inline-confirm"]').exists()).toBe(false)
    expect(button(wrapper, 'merge').text()).toBe('Mergear…')
    expect(postTaskAction).not.toHaveBeenCalled()
  })

  it('sin login de GitHub NO manda la request: pide iniciar sesión', async () => {
    const { wrapper, session } = mountActions(merge, false)
    await button(wrapper, 'merge').trigger('click')
    expect(postTaskAction).not.toHaveBeenCalled()
    expect(session.loginOpen).toBe(true)
  })

  it('Responder exige el texto, no confirma y lo manda', async () => {
    postTaskAction.mockResolvedValue({ ok: true, message: 'Comentado' })
    const { wrapper } = mountActions(doubt)
    expect(wrapper.get('label').text()).toBe('Respuesta')
    expect(button(wrapper, 'answer_and_unblock').attributes('disabled')).toBeDefined()

    await wrapper.get('textarea').setValue('  Son 90 días  ')
    expect(button(wrapper, 'answer_and_unblock').attributes('disabled')).toBeUndefined()
    await button(wrapper, 'answer_and_unblock').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-test="inline-confirm"]').exists()).toBe(false)
    expect(postTaskAction).toHaveBeenCalledWith(
      'acme/api#9',
      { action: 'answer_and_unblock', comment: 'Son 90 días' },
      'gho_1',
    )
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('')
  })

  it('un rechazo del runner queda pegado al botón: qué pasó, qué hacer y Reintentar', async () => {
    postTaskAction.mockResolvedValue({ ok: false, message: 'La tarea cambió' })
    const { wrapper } = mountActions()
    await button(wrapper, 'merge').trigger('click')
    await wrapper.get('[data-test="confirm"]').trigger('click')
    await flushPromises()
    const alert = wrapper.get('[data-action="merge"] [role="alert"]')
    expect(alert.text()).toContain('✕ No se pudo mergear: La tarea cambió')
    expect(alert.text()).toContain('→')
    expect(alert.find('button').text()).toBe('Reintentar')
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
          confirm: 'Se bloquea por la que indicaste.',
        },
      ],
    })
    const { wrapper } = mountActions(declared)

    // Las dos confirman: la declarada trae `confirm`, aprobar firma con GitHub.
    expect(button(wrapper, 'chain_behind').text()).toBe('Encadenarla detrás de otra…')
    expect(button(wrapper, 'approve_prd').text()).toBe('Aprobar…')

    // Pide comentario sólo para la que lo declara.
    expect(button(wrapper, 'chain_behind').attributes('disabled')).toBeDefined()
    expect(button(wrapper, 'approve_prd').attributes('disabled')).toBeUndefined()

    await wrapper.get('textarea').setValue('#1578')
    await button(wrapper, 'chain_behind').trigger('click')
    expect(wrapper.get('[data-test="inline-confirm"]').text()).toContain(
      'Se bloquea por la que indicaste.',
    )
    expect(wrapper.get('[data-test="confirm"]').text()).toBe('Encadenarla detrás de otra ahora')
    await wrapper.get('[data-test="confirm"]').trigger('click')
    await flushPromises()

    expect(postTaskAction).toHaveBeenCalledWith(
      'acme/api#7',
      { action: 'chain_behind', comment: '#1578' },
      'gho_1',
    )
  })
})
