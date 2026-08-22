import type { PullRequestRef } from '@ia-flow/shared'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import TaskTags from '../TaskTags.vue'

function pr(overrides: Partial<PullRequestRef> = {}): PullRequestRef {
  return {
    number: 7,
    url: 'https://github.com/o/r/pull/7',
    state: 'open',
    isDraft: false,
    ...overrides,
  }
}

describe('TaskTags', () => {
  it('usa la url como key, no el número — dos repos pueden repetir el #', () => {
    const wrapper = mount(TaskTags, {
      props: {
        devLinks: true,
        pullRequests: [
          pr({ number: 7, url: 'https://github.com/o/repo-a/pull/7' }),
          pr({ number: 7, url: 'https://github.com/o/repo-b/pull/7' }),
        ],
      },
    })
    expect(wrapper.findAll('.task-dev-chip')).toHaveLength(2)
  })

  it('no afirma "Sin PR" cuando no sabemos si hay PRs', () => {
    const wrapper = mount(TaskTags, {
      props: { devLinks: true, pullRequests: [], pullRequestsKnown: false, branch: 'x' },
    })
    expect(wrapper.text()).not.toContain('Sin PR')
  })

  it('sí afirma "Sin PR" cuando el provider respondió y no hay ninguno', () => {
    const wrapper = mount(TaskTags, {
      props: { devLinks: true, pullRequests: [], branch: 'x' },
    })
    expect(wrapper.text()).toContain('Sin PR')
  })

  it('un provider sin dev links no habla de ramas ni PRs', () => {
    const wrapper = mount(TaskTags, { props: { repos: ['ia-flow'] } })
    expect(wrapper.find('.task-dev-empty').exists()).toBe(false)
    expect(wrapper.find('.task-dev-chip').exists()).toBe(false)
  })
})
