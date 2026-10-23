import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GithubIssue, GithubSearchApi } from '@/features/github-search/api'
import type { AddOutcome, AddRequest, BoardEntry } from '@/features/github-search/board'
import GithubSearchPanel from '@/features/github-search/GithubSearchPanel.vue'
import { clearRepoCache } from '@/features/github-search/useGithubSearch'
import { useGithubSessionStore } from '@/stores/githubSession'

// «Buscar en GitHub» sin red: GitHub de mentira y el board armado a mano. Lo que está en el board
// se abre en la app (emite `open`), lo que no se agrega desde la fila; sólo el ↗ sale a GitHub.

const issue = (ref: string, over: Partial<GithubIssue> = {}): GithubIssue => ({
  ref,
  title: `Título de ${ref}`,
  url: `https://github.com/${ref.replace('#', '/issues/')}`,
  open: true,
  isPR: false,
  updatedAt: '2026-10-01T10:00:00Z',
  ...over,
})

const board = new Map<string, BoardEntry>([
  ['acme/api#7', { ref: 'acme/api#7', status: 'Review' }],
  // el PR #12 es de la tarea acme/api#7
  ['acme/api#12', { ref: 'acme/api#7', status: 'Review' }],
])

function fakeApi(over: Partial<GithubSearchApi> = {}) {
  return {
    search: vi.fn(async () => [
      issue('acme/api#7'),
      issue('acme/api#12', { isPR: true }),
      issue('acme/web#3'),
      issue('acme/web#4', { open: false }),
    ]),
    repos: vi.fn(async () => ['web', 'api', 'cli']),
    issue: vi.fn(async (ref: string) => issue(ref)),
    ...over,
  }
}

const settle = async () => {
  await flushPromises()
  await new Promise((r) => setTimeout(r, 0))
  await flushPromises()
}

function render(opts: {
  api?: ReturnType<typeof fakeApi>
  add?: (r: AddRequest) => Promise<AddOutcome>
  login?: boolean
  query?: string
}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const session = useGithubSessionStore()
  session.github = opts.login === false ? null : { token: 'tok', login: 'yo' }
  const api = opts.api ?? fakeApi()
  const makeApi = vi.fn(() => api)
  const add = vi.fn(opts.add ?? (async () => ({ ok: true, status: 'Todo' }) as AddOutcome))
  const w = mount(GithubSearchPanel, {
    props: {
      org: 'acme',
      boardRepos: ['acme/api', 'other/x'],
      board,
      projects: [
        { id: 'core', statuses: ['Refine', 'Todo', 'Build'], repos: ['acme/api', 'acme/web'] },
      ],
      add,
      api: makeApi,
      delay: 0,
      initialQuery: opts.query ?? 'etapa',
    },
    global: { plugins: [pinia] },
  })
  return { w, api, makeApi, add, session }
}

const row = (w: ReturnType<typeof render>['w'], ref: string) => w.get(`[data-ref="${ref}"]`)

beforeEach(() => {
  clearRepoCache()
  localStorage.clear()
})

describe('GithubSearchPanel', () => {
  it('busca lo escrito en toda la org, con el aviso de sólo lectura y Abierto/Cerrado · issue/PR', async () => {
    const { w, api } = render({})
    await settle()
    expect(api.search).toHaveBeenCalledWith('etapa', 'acme', null)
    expect(w.get('[data-test="scope"]').text()).toContain('Toda acme')
    expect(w.text()).toContain(
      'Usa tu login de GitHub (sólo lectura). Con un repo elegido, un número va directo a ese issue o PR.',
    )
    expect(row(w, 'acme/api#7').text()).toContain('Abierto · issue')
    expect(row(w, 'acme/api#12').text()).toContain('Abierto · PR')
    expect(row(w, 'acme/web#4').text()).toContain('Cerrado · issue')
  })

  it('lo que está en el board dice su columna y se abre DENTRO de la app; un PR abre su tarea', async () => {
    const { w } = render({})
    await settle()
    expect(row(w, 'acme/api#7').get('[data-test="in-board"]').text()).toBe('En el board · Review')
    await row(w, 'acme/api#7').get('[data-test="open"]').trigger('click')
    await row(w, 'acme/api#12').get('[data-test="open"]').trigger('click')
    expect(w.emitted('open')).toEqual([['acme/api#7'], ['acme/api#7']])
    // Nada navega afuera salvo el ↗, en otra pestaña.
    for (const a of w.findAll('a')) expect(a.attributes('target')).toBe('_blank')
    expect(row(w, 'acme/api#7').get('[data-test="github"]').attributes('href')).toBe(
      'https://github.com/acme/api/issues/7',
    )
  })

  it('un issue abierto fuera del board se agrega en la columna elegida; un cerrado no', async () => {
    const { w, add } = render({ add: async () => ({ ok: true, status: 'Build' }) })
    await settle()
    expect(row(w, 'acme/web#3').find('[data-test="open"]').exists()).toBe(false)
    expect(row(w, 'acme/web#4').find('[data-test="add-toggle"]').exists()).toBe(false)
    expect(row(w, 'acme/api#12').find('[data-test="add-toggle"]').exists()).toBe(false)
    await row(w, 'acme/web#3').get('[data-test="add-toggle"]').trigger('click')
    const options = row(w, 'acme/web#3').findAll('[data-test="add-column"]')
    expect(options.map((o) => o.text())).toEqual(['Todo (por defecto)', 'Refine', 'Build'])
    await options[2]?.trigger('click')
    await flushPromises()
    expect(add).toHaveBeenCalledWith({ issue: 'acme/web#3', project_id: 'core', status: 'Build' })
    expect(row(w, 'acme/web#3').get('[data-test="in-board"]').text()).toBe('En el board · Build')
    expect(row(w, 'acme/web#3').find('[data-test="open"]').exists()).toBe(true)
  })

  it('si el runner no lo agrega, lo dice en la fila', async () => {
    const { w } = render({ add: async () => ({ ok: false, message: 'el repo no es del board' }) })
    await settle()
    await row(w, 'acme/web#3').get('[data-test="add-toggle"]').trigger('click')
    await row(w, 'acme/web#3').get('[data-test="add-column"]').trigger('click')
    await flushPromises()
    expect(row(w, 'acme/web#3').get('[data-test="add-failure"]').text()).toContain(
      'el repo no es del board',
    )
  })

  it('sin login no manda nada: pide iniciar sesión', async () => {
    const { w, makeApi, session } = render({ login: false })
    await settle()
    expect(makeApi).not.toHaveBeenCalled()
    expect(w.get('[data-test="note"]').text()).toBe(
      'Inicia sesión con GitHub para buscar en los repos de acme.',
    )
    await w.get('[data-test="login"] button').trigger('click')
    expect(session.loginOpen).toBe(true)
  })

  it('un número sin repo pide elegir uno; con el repo elegido (recordado) va directo', async () => {
    const { w, api } = render({ query: '12' })
    await settle()
    expect(w.get('[data-test="note"]').text()).toContain('Elige un repo para buscar #12')
    expect(api.issue).not.toHaveBeenCalled()
    await w.get('[data-test="scope"]').trigger('click')
    await settle()
    const picker = w.get('[data-test="repo-picker"]')
    // los del board primero, después el resto por actividad
    expect(picker.findAll('.rp__name').map((n) => n.text())).toEqual([
      'Toda acme',
      'api',
      'web',
      'cli',
    ])
    await w.get('[data-test="repo-api"]').trigger('click')
    await settle()
    expect(api.issue).toHaveBeenCalledWith('acme/api#12')
    expect(localStorage.getItem('ia-flow:github-search:repo:acme')).toBe('api')
    expect(w.get('[data-test="scope"]').text()).toContain('api')
  })

  it('un error de GitHub se dice; texto corto pide 3 letras; lo escrito se emite', async () => {
    const api = fakeApi({ search: vi.fn(async () => Promise.reject(new Error('boom'))) })
    const { w } = render({ api })
    await settle()
    expect(w.get('[data-test="note"]').text()).toBe('GitHub no respondió: Error: boom')
    await w.get('[data-test="query"]').setValue('et')
    await settle()
    expect(w.get('[data-test="note"]').text()).toBe('Escribe al menos 3 letras.')
    expect(w.emitted('query')?.at(-1)).toEqual(['et'])
  })
})
