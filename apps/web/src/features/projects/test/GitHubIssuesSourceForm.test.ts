import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import GitHubIssuesSourceForm from '../sources/GitHubIssuesSourceForm.vue'

describe('GitHubIssuesSourceForm', () => {
  it('edits the three keys the source factory validates', async () => {
    const wrapper = mount(GitHubIssuesSourceForm, { props: { modelValue: {} } })
    const [owner, repo, anchor] = wrapper.findAll('input')

    await owner.setValue('julianjab')
    await repo.setValue('accountant')
    await anchor.setValue('ia-flow')

    const emitted = wrapper.emitted('update:modelValue') ?? []
    expect(emitted.map((e) => e[0])).toEqual([
      { owner: 'julianjab' },
      { repo: 'accountant' },
      { anchorLabel: 'ia-flow' },
    ])
  })

  it('preserves the other keys when one field changes', async () => {
    const wrapper = mount(GitHubIssuesSourceForm, {
      props: { modelValue: { owner: 'julianjab', repo: 'old' } },
    })
    await wrapper.findAll('input')[1].setValue('accountant')
    expect(wrapper.emitted('update:modelValue')?.[0][0]).toEqual({
      owner: 'julianjab',
      repo: 'accountant',
    })
  })

  it('links to the repo issues only once owner and repo are both set', async () => {
    const wrapper = mount(GitHubIssuesSourceForm, { props: { modelValue: { owner: 'julianjab' } } })
    expect(wrapper.find('.gisf-link').exists()).toBe(false)

    await wrapper.setProps({ modelValue: { owner: 'julianjab', repo: 'accountant' } })
    expect(wrapper.get('.gisf-link').attributes('href')).toBe(
      'https://github.com/julianjab/accountant/issues',
    )
  })
})
