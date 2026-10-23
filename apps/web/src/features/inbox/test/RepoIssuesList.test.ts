import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it, vi } from 'vitest'

// «En los repos, sin card»: por repo, cada issue con su botón para entrar al board; el error de un
// repo no tapa al resto; un runner que no lo publica (null) no dibuja nada.

const getRepoIssues = vi.fn()
const postBoardItem = vi.fn()
vi.mock('@/features/inbox/api', () => ({
  getInbox: vi.fn().mockResolvedValue({ generated_at: 'x', projects: [], items: [] }),
  getTasks: vi.fn().mockResolvedValue(null),
  getRepoIssues: (...a: unknown[]) => getRepoIssues(...a),
  postBoardItem: (...a: unknown[]) => postBoardItem(...a),
}))
vi.mock('@/features/inbox/githubToken', () => ({ tokenOrLogin: async () => 'gho_1' }))
vi.mock('@/composables/useServerTarget', () => ({
  serverTarget: () => ({ base: 'https://runner.test', url: (p: string) => p }),
}))

import RepoIssuesList from '@/features/inbox/pipeline/RepoIssuesList.vue'

const projects = [
  { id: 'core', board: { owner: 'acme', number: 1 }, statuses: ['Backlog', 'Todo', 'Build'] },
]

async function render() {
  setActivePinia(createPinia())
  const w = mount(RepoIssuesList, { props: { projects } })
  await flushPromises()
  return w
}

describe('RepoIssuesList', () => {
  it('agrupa por repo, muestra el error de un repo y agrega al board en la columna de entrada', async () => {
    getRepoIssues.mockResolvedValue({
      repos: [
        {
          repo: 'acme/api',
          project_id: 'core',
          items: [
            {
              ref: 'acme/api#40',
              project_id: 'core',
              title: 'Exportar a CSV',
              url: 'https://github.com/acme/api/issues/40',
              labels: [],
              updated_at: '2026-01-01T10:00:00.000Z',
              author: 'ada',
            },
          ],
          truncated: true,
        },
        {
          repo: 'acme/ims',
          project_id: 'core',
          items: [],
          error: 'El runner no tiene permiso para leer sus issues',
        },
      ],
    })
    postBoardItem.mockResolvedValue({
      ok: true,
      message: 'agregado',
      ref: 'acme/api#40',
      status: 'Todo',
    })
    const w = await render()
    expect(w.findAll('.ri__repo-name').map((h) => h.text())).toEqual(['acme/api 1', 'acme/ims 0'])
    expect(w.text()).toContain('@ada')
    expect(w.text()).toContain('El runner no tiene permiso para leer sus issues')
    expect(w.text()).toContain('Hay más en GitHub')
    expect((w.get('select').element as HTMLSelectElement).value).toBe('Todo')
    await w.get('[data-test="add-issue"]').trigger('click')
    await flushPromises()
    expect(postBoardItem).toHaveBeenCalledWith(
      { issue: 'acme/api#40', project_id: 'core', status: 'Todo' },
      'gho_1',
    )
    w.unmount()
  })

  it('con un runner que no lo publica no dibuja nada', async () => {
    getRepoIssues.mockResolvedValue(null)
    const w = await render()
    expect(w.find('[data-test="repo-issues"]').exists()).toBe(false)
    w.unmount()
  })
})
