import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

const getInbox = vi.fn()
const postTaskStatus = vi.fn()
const postBoardItem = vi.fn()
vi.mock('@/features/inbox/api', () => ({
  getInbox: (...a: unknown[]) => getInbox(...a),
  getTasks: vi.fn().mockResolvedValue(null),
  getTaskDetail: vi.fn(),
  postTaskAction: vi.fn(),
  postTaskStatus: (...a: unknown[]) => postTaskStatus(...a),
  postBoardItem: (...a: unknown[]) => postBoardItem(...a),
}))
vi.mock('@/composables/useIsMobile', () => ({
  useIsMobile: () => ({ isMobile: ref(false) }),
  useIsSplit: () => ({ isSplit: ref(true) }),
}))

import FeedList from '@/features/inbox/pipeline/FeedList.vue'
import { buildQueue } from '@/features/inbox/queue/build'
import { useGithubSessionStore } from '@/stores/githubSession'

const NOW = Date.parse('2026-01-01T10:12:00.000Z')
const core = {
  id: 'core',
  board: { owner: 'acme', number: 1 },
  statuses: ['Backlog', 'Todo', 'Refine', 'Build'],
}
const web = { id: 'web', board: { owner: 'acme', number: 2 }, statuses: ['Ready', 'Todo', 'Doing'] }
const card = {
  ref: 'acme/api#7',
  project_id: 'core',
  title: 'Cache de tarifas',
  url: 'https://github.com/acme/api/issues/7',
  status: 'Todo',
  labels: [],
  updated_at: 'x',
}

function setup(signedIn = true) {
  const pinia = createPinia()
  setActivePinia(pinia)
  if (signedIn) useGithubSessionStore().github = { token: 'gho_1', login: 'ada' }
  return pinia
}

function mountFeed(projects: (typeof core)[], signedIn = true) {
  const pinia = setup(signedIn)
  const q = buildQueue({ items: [], now: NOW, runner: { feed: { ready: [card], waiting: [] } } })
  return mount(FeedList, {
    props: { feed: q.feed as NonNullable<typeof q.feed>, projects },
    global: { plugins: [pinia] },
  })
}

beforeEach(() => {
  getInbox.mockReset().mockResolvedValue({ generated_at: 'x', projects: [], items: [] })
  postTaskStatus
    .mockReset()
    .mockResolvedValue({ ok: true, message: 'Movida a Refine', github_login: 'ada' })
  postBoardItem.mockReset().mockResolvedValue({ ok: true, message: 'Agregada', ref: 'acme/api#9' })
})

describe('«Mover a…» en el feed', () => {
  it('ofrece las columnas del proyecto de la card, sin la suya, y mueve con tu token', async () => {
    const w = mountFeed([core, web])
    const select = w.get('.fl__row select')
    const options = select.findAll('option').map((o) => o.text())
    expect(options).toEqual(['Mover a…', 'Backlog', 'Refine', 'Build'])

    await select.setValue('Refine')
    await flushPromises()
    expect(postTaskStatus).toHaveBeenCalledWith('acme/api#7', 'Refine', 'gho_1')
    expect(getInbox).toHaveBeenCalled()
    expect(w.get('.fl__row [role="status"]').text()).toBe('✓ Movida a Refine · @ada')
    expect((select.element as HTMLSelectElement).value).toBe('')
  })

  it('el rechazo del runner queda en línea y «Reintentar» lo vuelve a pedir', async () => {
    postTaskStatus.mockResolvedValueOnce({ ok: false, message: 'Hay un agente corriendo' })
    const w = mountFeed([core])
    await w.get('.fl__row select').setValue('Build')
    await flushPromises()
    const error = w.get('.fl__row [data-test="action-error"]')
    expect(error.text()).toContain('Hay un agente corriendo')
    expect(getInbox).not.toHaveBeenCalled()

    await error.get('button').trigger('click')
    await flushPromises()
    expect(postTaskStatus).toHaveBeenLastCalledWith('acme/api#7', 'Build', 'gho_1')
    expect(w.find('.fl__row [data-test="action-error"]').exists()).toBe(false)
  })

  it('sin columnas del runner no hay «Mover a…» ni formulario', () => {
    const w = mountFeed([])
    expect(w.find('[data-test="move-to"]').exists()).toBe(false)
    expect(w.find('[data-test="add-to-board"]').exists()).toBe(false)
  })

  it('sin sesión de GitHub pide el login y no mueve nada', async () => {
    const w = mountFeed([core], false)
    await w.get('.fl__row select').setValue('Refine')
    await flushPromises()
    expect(postTaskStatus).not.toHaveBeenCalled()
    expect(useGithubSessionStore().loginOpen).toBe(true)
  })
})

describe('«Agregar al board» al pie del feed', () => {
  it('con un proyecto: sin selector de proyecto, la columna arranca en Todo', async () => {
    const w = mountFeed([core])
    const form = w.get('[data-test="add-to-board"]')
    expect(form.findAll('select')).toHaveLength(1)
    const column = form.get('select[aria-label="Columna"]')
    expect((column.element as HTMLSelectElement).value).toBe('Todo')

    expect(form.get('button').attributes('disabled')).toBeDefined()
    await form.get('input').setValue('acme/api#9')
    await form.trigger('submit')
    await flushPromises()
    expect(postBoardItem).toHaveBeenCalledWith(
      { issue: 'acme/api#9', project_id: 'core', status: 'Todo' },
      'gho_1',
    )
    expect(getInbox).toHaveBeenCalled()
    expect(form.get('[role="status"]').text()).toBe('✓ Agregada')
    expect((form.get('input').element as HTMLInputElement).value).toBe('')
  })

  it('con varios proyectos se elige el proyecto y sus columnas', async () => {
    const w = mountFeed([core, web])
    const form = w.get('[data-test="add-to-board"]')
    await form.get('select[aria-label="Proyecto"]').setValue('web')
    const column = form.get('select[aria-label="Columna"]')
    expect(column.findAll('option').map((o) => o.text())).toEqual(['Ready', 'Todo', 'Doing'])
    expect((column.element as HTMLSelectElement).value).toBe('Todo')
    await column.setValue('Doing')
    await form.get('input').setValue('https://github.com/acme/web/issues/3')
    await form.trigger('submit')
    await flushPromises()
    expect(postBoardItem).toHaveBeenCalledWith(
      { issue: 'https://github.com/acme/web/issues/3', project_id: 'web', status: 'Doing' },
      'gho_1',
    )
  })

  it('el error del runner se muestra en línea y no relee la bandeja', async () => {
    postBoardItem.mockResolvedValueOnce({ ok: false, message: 'Ya está en el board' })
    const w = mountFeed([core])
    const form = w.get('[data-test="add-to-board"]')
    await form.get('input').setValue('acme/api#7')
    await form.trigger('submit')
    await flushPromises()
    expect(form.get('[data-test="action-error"]').text()).toContain('Ya está en el board')
    expect(getInbox).not.toHaveBeenCalled()
    expect((form.get('input').element as HTMLInputElement).value).toBe('acme/api#7')
  })

  it('sin sesión, el botón invita a iniciarla', async () => {
    const w = mountFeed([core], false)
    const button = w.get('[data-test="add-to-board"] button')
    expect(button.text()).toBe('Iniciá sesión para agregar')
    expect(button.attributes('disabled')).toBeUndefined()
    expect(button.attributes('type')).toBe('submit')
    await w.get('[data-test="add-to-board"]').trigger('submit')
    await flushPromises()
    expect(useGithubSessionStore().loginOpen).toBe(true)
    expect(postBoardItem).not.toHaveBeenCalled()
  })
})
