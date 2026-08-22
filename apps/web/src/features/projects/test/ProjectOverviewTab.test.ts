import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@ia-flow/shared'
import ProjectOverviewTab from '../tabs/ProjectOverviewTab.vue'

vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/features/projects/sourceApi', () => ({
  fetchProjectHealth: vi.fn(async () => ({ ok: true, missing: [], warnings: [] })),
}))

function project(source: Project['source']): Project {
  return { id: 'p1', name: 'p1', source } as Project
}

const link = (wrapper: ReturnType<typeof mount>) => wrapper.find('.pot-source__link')

describe('ProjectOverviewTab — link a GitHub', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('links a github-issues project to its issues, built from owner/repo', () => {
    const wrapper = mount(ProjectOverviewTab, {
      props: {
        project: project({
          kind: 'github-issues',
          config: { owner: 'julianjab', repo: 'accountant' },
        }),
      },
    })
    expect(link(wrapper).attributes('href')).toBe('https://github.com/julianjab/accountant/issues')
  })

  it('links a github project to the board URL it stores', () => {
    const wrapper = mount(ProjectOverviewTab, {
      props: {
        project: project({
          kind: 'github',
          config: { url: 'https://github.com/users/julianjab/projects/2' },
        }),
      },
    })
    expect(link(wrapper).attributes('href')).toBe('https://github.com/users/julianjab/projects/2')
  })

  it.each([
    ['github-issues sin repo', { kind: 'github-issues', config: { owner: 'julianjab' } }],
    ['github sin url', { kind: 'github', config: {} }],
    ['local', { kind: 'local', config: {} }],
  ])('shows no link for %s', (_label, source) => {
    const wrapper = mount(ProjectOverviewTab, {
      props: { project: project(source as Project['source']) },
    })
    expect(link(wrapper).exists()).toBe(false)
  })
})
