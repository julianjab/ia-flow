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
    expect(wrapper.findAll('.tag--pr')).toHaveLength(2)
  })

  it('no afirma "Sin PR" cuando no sabemos si hay PRs', () => {
    const wrapper = mount(TaskTags, {
      props: { devLinks: true, pullRequests: [], pullRequestsKnown: false, branch: 'x' },
    })
    expect(wrapper.text()).not.toContain('sin PR')
  })

  it('sí afirma "Sin PR" cuando el provider respondió y no hay ninguno', () => {
    const wrapper = mount(TaskTags, {
      props: { devLinks: true, pullRequests: [], branch: 'x' },
    })
    expect(wrapper.text()).toContain('sin PR')
  })

  it('un provider sin dev links no habla de ramas ni PRs', () => {
    const wrapper = mount(TaskTags, { props: { repos: ['ia-flow'] } })
    expect(wrapper.find('.tag-empty').exists()).toBe(false)
    expect(wrapper.find('.tag--branch').exists()).toBe(false)
    expect(wrapper.find('.tag--pr').exists()).toBe(false)
  })

  it('el glifo, no la palabra, es lo que colorea el estado del PR', () => {
    const wrapper = mount(TaskTags, {
      props: { devLinks: true, pullRequests: [pr({ state: 'merged' })] },
    })
    const chip = wrapper.get('.tag--pr')
    expect(chip.classes()).toContain('is-merged')
    expect(chip.get('.tag__glyph').text()).toBe('✓')
    expect(chip.get('.tag__text').text()).toBe('PR #7')
    expect(chip.get('.tag__meta').text()).toBe('mergeado')
  })

  it('una rama sin url se dibuja igual, pero no como link', () => {
    const wrapper = mount(TaskTags, { props: { devLinks: true, branch: 'fix/algo' } })
    const chip = wrapper.get('.tag--branch')
    expect(chip.element.tagName).toBe('SPAN')
    expect(chip.get('.tag__text').text()).toBe('fix/algo')
  })
})
