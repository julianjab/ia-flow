import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { useGithubSessionStore } from '@/stores/githubSession'

// La view compone la búsqueda con la bandeja: la org y el board salen de la bandeja, un resultado
// del board abre su detalle sin salir de /buscar y agregar va por el runner con tu login.

const getBoardRest = vi.fn(async () => ({
  columns: [
    {
      status: 'Done',
      items: [
        {
          ref: 'acme/api#5',
          project_id: 'core',
          title: 'Viejo',
          url: 'https://github.com/acme/api/issues/5',
          labels: [],
          updated_at: '2026-10-01T10:00:00Z',
        },
      ],
    },
  ],
}))
const postBoardItem = vi.fn(async () => ({ ok: true, message: 'agregado', status: 'Todo' }))
vi.mock('@/features/inbox/api', () => ({
  getInbox: vi.fn(),
  getTasks: vi.fn(),
  getBoardRest: () => getBoardRest(),
  getTaskDetail: vi.fn(async () => ({ item: {}, executions: [], events: [], trace: [] })),
  postBoardItem: (...a: unknown[]) => postBoardItem(...(a as [])),
  getRepoIssues: vi.fn(),
}))

const search = vi.fn(async (_text: string, _org: string, _repo: string | null) => [
  {
    ref: 'acme/api#5',
    title: 'Viejo',
    url: 'https://github.com/acme/api/issues/5',
    open: false,
    isPR: false,
    updatedAt: '2026-10-01T10:00:00Z',
  },
  {
    ref: 'acme/api#9',
    title: 'Nuevo',
    url: 'https://github.com/acme/api/issues/9',
    open: true,
    isPR: false,
    updatedAt: '2026-10-01T10:00:00Z',
  },
])
vi.mock('@/features/github-search/api', async (orig) => ({
  ...(await orig<typeof import('@/features/github-search/api')>()),
  createGithubSearchApi: () => ({ search, repos: async () => [], issue: async () => null }),
}))

import { useInboxStore } from '@/features/inbox/store'
import { inbox } from '@/features/inbox/test/fixtures'
import GithubSearchView from '@/views/GithubSearchView.vue'

async function render() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/buscar', name: 'github-search', component: GithubSearchView }],
  })
  await router.push('/buscar?q=viejo')
  await router.isReady()
  const pinia = createPinia()
  setActivePinia(pinia)
  useGithubSessionStore().github = { token: 'tok', login: 'yo' }
  const store = useInboxStore()
  store.inbox = inbox([], [
    {
      id: 'core',
      board: { owner: 'acme', number: 1 },
      statuses: ['Todo', 'Build'],
      repos: ['acme/api'],
    },
  ] as never)
  const w = mount({ template: '<router-view />' }, { global: { plugins: [router, pinia] } })
  await flushPromises()
  await new Promise((r) => setTimeout(r, 400))
  await flushPromises()
  return { w, store, router }
}

describe('GithubSearchView', () => {
  it('busca lo que trajo la URL en la org del board y abre lo del board en su detalle, sin navegar', async () => {
    const { w, store, router } = await render()
    expect(search).toHaveBeenCalledWith('viejo', 'acme', null)
    expect(getBoardRest).toHaveBeenCalled()
    const row = w.get('[data-ref="acme/api#5"]')
    expect(row.text()).toContain('En el board · Done')
    await row.get('[data-test="open"]').trigger('click')
    expect(store.openRef).toBe('acme/api#5')
    expect(store.expanded).toBe(true)
    expect(router.currentRoute.value.fullPath).toBe('/buscar?q=viejo')
  })

  it('agregar un issue va por el runner con el token y la fila dice su columna', async () => {
    const { w } = await render()
    const row = w.get('[data-ref="acme/api#9"]')
    await row.get('[data-test="add-toggle"]').trigger('click')
    await row.get('[data-test="add-column"]').trigger('click')
    await flushPromises()
    expect(postBoardItem).toHaveBeenCalledWith(
      { issue: 'acme/api#9', project_id: 'core', status: 'Todo' },
      'tok',
    )
    expect(w.get('[data-ref="acme/api#9"] [data-test="in-board"]').text()).toBe(
      'En el board · Todo',
    )
  })
})
