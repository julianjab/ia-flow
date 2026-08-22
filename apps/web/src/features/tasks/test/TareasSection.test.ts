import type { SourceItem } from '@/features/projects/sourceApi'
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import TareasSection from '../TareasSection.vue'

const items: SourceItem[] = []

vi.mock('@/features/projects/store', () => ({
  useProjectsStore: () => ({ activeProjectId: 'p1' }),
}))
vi.mock('@/stores/toast', () => ({
  useToastStore: () => ({ success: vi.fn(), error: vi.fn() }),
}))
vi.mock('@/features/repos/api', () => ({
  getRepoMappings: vi.fn(async () => []),
}))
vi.mock('@/features/projects/sourceApi', () => ({
  fetchProjectItems: vi.fn(async () => ({ kind: 'github-issues', items })),
  fetchItemBlockers: vi.fn(async () => ({ kind: 'github-issues', blockers: [] })),
  setProjectItemField: vi.fn(async () => {}),
}))

function githubItem(meta: Record<string, unknown>): SourceItem {
  return {
    id: 'I_1',
    title: 'Do the thing',
    status: 'refine',
    repos: 'ia-flow',
    url: 'https://github.com/la-haus/ia-flow/issues/42',
    meta: { issueNumber: 42, ...meta },
  }
}

async function mountWith(list: SourceItem[]) {
  items.splice(0, items.length, ...list)
  const wrapper = mount(TareasSection)
  await flushPromises()
  return wrapper
}

describe('TareasSection — dev links', () => {
  it('linkea el número de issue al item en la plataforma del provider', async () => {
    const wrapper = await mountWith([githubItem({ pullRequests: [] })])
    const link = wrapper.get('.task-number-link')
    expect(link.attributes('href')).toBe('https://github.com/la-haus/ia-flow/issues/42')
    expect(link.attributes('target')).toBe('_blank')
  })

  it('muestra la rama remota como link y el PR con su estado', async () => {
    const wrapper = await mountWith([
      githubItem({
        linkedBranch: 'fix/algo',
        branchUrl: 'https://github.com/la-haus/ia-flow/tree/fix%2Falgo',
        pullRequests: [
          {
            number: 7,
            url: 'https://github.com/la-haus/ia-flow/pull/7',
            state: 'merged',
            isDraft: false,
          },
        ],
      }),
    ])
    const chips = wrapper.findAll('.task-dev-chip')
    expect(chips[0].text()).toContain('fix/algo')
    expect(chips[0].attributes('href')).toBe('https://github.com/la-haus/ia-flow/tree/fix%2Falgo')
    expect(chips[1].text()).toBe('PR #7 · mergeado')
    expect(chips[1].classes()).toContain('is-pr-merged')
    expect(wrapper.find('.task-dev-empty').exists()).toBe(false)
  })

  it('marca explícitamente la ausencia de rama y de PR', async () => {
    const wrapper = await mountWith([githubItem({ pullRequests: [] })])
    const empties = wrapper.findAll('.task-dev-empty').map((e) => e.text())
    expect(empties).toEqual(['Sin rama remota', 'Sin PR'])
  })

  it('un PR en draft se rotula draft, no por su state', async () => {
    const wrapper = await mountWith([
      githubItem({
        pullRequests: [{ number: 9, url: 'u', state: 'open', isDraft: true }],
      }),
    ])
    const pr = wrapper.findAll('.task-dev-chip').at(-1)!
    expect(pr.text()).toBe('PR #9 · draft')
    expect(pr.classes()).toContain('is-pr-draft')
  })

  it('providers sin noción de ramas/PRs no dicen nada de ramas ni PRs', async () => {
    const wrapper = await mountWith([
      { id: 'L_1', title: 'Local task', status: 'queued', repos: 'algo' },
    ])
    expect(wrapper.find('.task-dev-chip').exists()).toBe(false)
    expect(wrapper.find('.task-dev-empty').exists()).toBe(false)
  })

  it('los tags de repo, rama y PR viven en la misma fila, sin botón de editar', async () => {
    const wrapper = await mountWith([
      githubItem({
        linkedBranch: 'fix/algo',
        pullRequests: [{ number: 7, url: 'u', state: 'open', isDraft: false }],
      }),
    ])
    const row = wrapper.get('.task-tags-row')
    expect(row.findAll('.task-repo-chip').map((c) => c.text())).toEqual(['ia-flow'])
    expect(row.findAll('.task-dev-chip')).toHaveLength(2)
    expect(wrapper.find('.btn-edit').exists()).toBe(false)
  })
})
