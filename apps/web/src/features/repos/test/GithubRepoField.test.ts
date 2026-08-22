import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import GithubRepoField from '../GithubRepoField.vue'

const getOwners = vi.fn(async () => ({
  owners: [
    { login: 'julianjab', type: 'user' },
    { login: 'la-haus', type: 'org' },
  ],
}))
const getRepos = vi.fn(async (owner: string) => ({
  repos: owner === 'julianjab' ? ['accountant', 'world-clock'] : ['ia-flow'],
}))

vi.mock('@/features/github/api', () => ({
  getOwners: () => getOwners(),
  getRepos: (owner: string) => getRepos(owner),
}))

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const lastEmit = (wrapper: ReturnType<typeof mount>) => {
  const events = wrapper.emitted('update:modelValue') ?? []
  return events[events.length - 1]?.[0]
}

describe('GithubRepoField', () => {
  beforeEach(() => {
    getOwners.mockClear()
    getRepos.mockClear()
  })

  it('splits a pasted repo URL into owner and repo', async () => {
    const wrapper = mount(GithubRepoField, { props: { owner: '', repo: '' } })
    await wrapper.get('input').setValue('https://github.com/julianjab/accountant')
    expect(lastEmit(wrapper)).toEqual({ owner: 'julianjab', repo: 'accountant' })
  })

  it('shows the saved pair as owner/repo', () => {
    const wrapper = mount(GithubRepoField, {
      props: { owner: 'julianjab', repo: 'accountant' },
    })
    expect((wrapper.get('input').element as HTMLInputElement).value).toBe('julianjab/accountant')
  })

  it('suggests owners until one is typed, then that owner repos', async () => {
    const wrapper = mount(GithubRepoField, { props: { owner: '', repo: '' } })
    await flush()
    await wrapper.get('input').trigger('focus')
    expect(wrapper.findAll('li').map((li) => li.text())).toEqual(['julianjab/', 'la-haus/'])

    await wrapper.get('input').setValue('julianjab/')
    await flush()
    expect(getRepos).toHaveBeenCalledWith('julianjab')
    expect(wrapper.findAll('li').map((li) => li.text())).toEqual([
      'julianjab/accountant',
      'julianjab/world-clock',
    ])
  })

  it('fetches an owner repos once, not on every keystroke', async () => {
    const wrapper = mount(GithubRepoField, { props: { owner: '', repo: '' } })
    await wrapper.get('input').setValue('julianjab/a')
    await wrapper.get('input').setValue('julianjab/ac')
    await wrapper.get('input').setValue('julianjab/acc')
    await flush()
    expect(getRepos).toHaveBeenCalledTimes(1)
  })

  it('flags a half-typed ref instead of saving an owner with no repo', async () => {
    const wrapper = mount(GithubRepoField, { props: { owner: '', repo: '' } })
    await wrapper.get('input').setValue('julianjab')
    expect(wrapper.find('.grf-error').exists()).toBe(true)
    expect(lastEmit(wrapper)).toEqual({ owner: '', repo: '' })
  })

  it('keeps the typed text when the parent echoes back the empty pair', async () => {
    const wrapper = mount(GithubRepoField, {
      props: { owner: 'julianjab', repo: 'accountant' },
    })
    await wrapper.get('input').setValue('julianjab/')
    await wrapper.setProps({ owner: '', repo: '' })
    expect((wrapper.get('input').element as HTMLInputElement).value).toBe('julianjab/')
  })

  it('resyncs when the parent opens another repo card', async () => {
    const wrapper = mount(GithubRepoField, {
      props: { owner: 'julianjab', repo: 'accountant' },
    })
    await wrapper.setProps({ owner: 'la-haus', repo: 'ia-flow' })
    expect((wrapper.get('input').element as HTMLInputElement).value).toBe('la-haus/ia-flow')
  })
})
