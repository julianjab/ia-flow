import type { SourceItem } from '@/features/projects/sourceApi'
import ItemReposModal from '@/features/repos/ItemReposModal.vue'
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

  it('el número queda fuera del texto que trunca y el título lleva su tooltip', async () => {
    const wrapper = await mountWith([githubItem({ pullRequests: [] })])
    // El link vive en su propio nodo: truncar el título nunca se come el #42.
    expect(wrapper.get('.task-number-link').text()).toBe('#42↗')
    expect(wrapper.get('.task-title').attributes('title')).toBe('Do the thing')
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
    const branch = wrapper.get('.tag--branch')
    expect(branch.text()).toContain('fix/algo')
    expect(branch.attributes('href')).toBe('https://github.com/la-haus/ia-flow/tree/fix%2Falgo')
    const pr = wrapper.get('.tag--pr')
    expect(pr.text()).toContain('PR #7')
    expect(pr.classes()).toContain('is-merged')
    expect(wrapper.find('.tag-empty').exists()).toBe(false)
  })

  it('marca explícitamente la ausencia de rama y de PR', async () => {
    const wrapper = await mountWith([githubItem({ pullRequests: [] })])
    const empties = wrapper.findAll('.tag-empty').map((e) => e.text())
    expect(empties).toEqual(['sin rama', 'sin PR'])
  })

  it('un PR en draft se rotula draft, no por su state', async () => {
    const wrapper = await mountWith([
      githubItem({
        pullRequests: [{ number: 9, url: 'u', state: 'open', isDraft: true }],
      }),
    ])
    const pr = wrapper.get('.tag--pr')
    expect(pr.text()).toContain('PR #9')
    expect(pr.classes()).toContain('is-draft')
  })

  it('providers sin noción de ramas/PRs no dicen nada de ramas ni PRs', async () => {
    const wrapper = await mountWith([
      { id: 'L_1', title: 'Local task', status: 'queued', repos: 'algo' },
    ])
    expect(wrapper.find('.tag--branch').exists()).toBe(false)
    expect(wrapper.find('.tag--pr').exists()).toBe(false)
    expect(wrapper.find('.tag-empty').exists()).toBe(false)
  })

  it('los tags de repo, rama y PR viven en la misma fila, sin botón de editar', async () => {
    const wrapper = await mountWith([
      githubItem({
        linkedBranch: 'fix/algo',
        pullRequests: [{ number: 7, url: 'u', state: 'open', isDraft: false }],
      }),
    ])
    const row = wrapper.get('.task-tags-row')
    expect(row.findAll('.tag--repo').map((c) => c.text())).toEqual(['ia-flow'])
    expect(row.findAll('.tag--branch')).toHaveLength(1)
    expect(row.findAll('.tag--pr')).toHaveLength(1)
    expect(wrapper.find('.btn-edit').exists()).toBe(false)
  })
})

describe('TareasSection — detalle', () => {
  it('le pasa los dev links al modal de detalle', async () => {
    const wrapper = await mountWith([
      githubItem({
        linkedBranch: 'fix/algo',
        branchUrl: 'https://github.com/la-haus/ia-flow/tree/fix/algo',
        pullRequests: [{ number: 7, url: 'u', state: 'open', isDraft: false }],
      }),
    ])
    await wrapper.get('.task-card').trigger('click')
    const modal = wrapper.findComponent(ItemReposModal)
    expect(modal.props('branch')).toBe('fix/algo')
    expect(modal.props('devLinks')).toBe(true)
    expect(modal.props('issueUrl')).toBe('https://github.com/la-haus/ia-flow/issues/42')
    expect(modal.props('pullRequests')).toHaveLength(1)
  })
})
