import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import GitHubIssuesSourceForm from '../sources/GitHubIssuesSourceForm.vue'

const lastEmit = (wrapper: ReturnType<typeof mount>) => {
  const events = wrapper.emitted('update:modelValue') ?? []
  return events[events.length - 1]?.[0]
}

describe('GitHubIssuesSourceForm', () => {
  it('splits the pasted repo URL into the owner/repo the factory expects', async () => {
    const wrapper = mount(GitHubIssuesSourceForm, { props: { modelValue: {} } })
    await wrapper.findAll('input')[0].setValue('https://github.com/julianjab/accountant')
    expect(lastEmit(wrapper)).toEqual({ owner: 'julianjab', repo: 'accountant' })
  })

  it.each([
    ['github.com/julianjab/accountant', 'sin esquema'],
    ['https://github.com/julianjab/accountant/issues', 'con /issues'],
    ['https://github.com/julianjab/accountant.git', 'con .git'],
    ['julianjab/accountant', 'atajo owner/repo'],
  ])('accepts %s (%s)', async (input) => {
    const wrapper = mount(GitHubIssuesSourceForm, { props: { modelValue: {} } })
    await wrapper.findAll('input')[0].setValue(input)
    expect(lastEmit(wrapper)).toEqual({ owner: 'julianjab', repo: 'accountant' })
  })

  it('flags a URL without a repo instead of saving half a config', async () => {
    const wrapper = mount(GitHubIssuesSourceForm, { props: { modelValue: {} } })
    await wrapper.findAll('input')[0].setValue('https://github.com/julianjab')
    expect(wrapper.get('.gisf-error').text()).toContain('https://github.com/owner/repo')
    expect(lastEmit(wrapper)).toEqual({ owner: '', repo: '' })
  })

  it('rebuilds the URL from an already-saved owner/repo', () => {
    const wrapper = mount(GitHubIssuesSourceForm, {
      props: { modelValue: { owner: 'julianjab', repo: 'accountant' } },
    })
    const input = wrapper.findAll('input')[0].element as HTMLInputElement
    expect(input.value).toBe('https://github.com/julianjab/accountant')
    expect(wrapper.get('.gisf-hint').text()).toContain('julianjab')
  })

  it('keeps owner/repo when the anchor label changes', async () => {
    const wrapper = mount(GitHubIssuesSourceForm, {
      props: { modelValue: { owner: 'julianjab', repo: 'accountant' } },
    })
    await wrapper.findAll('input')[1].setValue('ia-flow')
    expect(lastEmit(wrapper)).toEqual({
      owner: 'julianjab',
      repo: 'accountant',
      anchorLabel: 'ia-flow',
    })
  })

  it.each([
    'https://gitlab.com/acme/api',
    'https://bitbucket.org/acme/api',
    'https://ghithub.com/acme/api',
  ])('rejects %s instead of reading the host as the owner', async (input) => {
    const wrapper = mount(GitHubIssuesSourceForm, { props: { modelValue: {} } })
    await wrapper.findAll('input')[0].setValue(input)
    expect(wrapper.find('.gisf-error').exists()).toBe(true)
    expect(lastEmit(wrapper)).toEqual({ owner: '', repo: '' })
  })

  it('keeps what the user typed when the parent echoes back the empty config', async () => {
    // El padre es la fuente de verdad del v-model: al tipear una URL a medias
    // emitimos owner/repo vacíos y nos los devuelve. Eso no debe borrar el input.
    const wrapper = mount(GitHubIssuesSourceForm, {
      props: { modelValue: { owner: 'julianjab', repo: 'accountant' } },
    })
    const input = wrapper.findAll('input')[0]
    await input.setValue('https://github.com/julianjab/')
    await wrapper.setProps({ modelValue: { owner: '', repo: '' } })

    expect((input.element as HTMLInputElement).value).toBe('https://github.com/julianjab/')
    expect(wrapper.find('.gisf-error').exists()).toBe(true)
  })

  it('resyncs the URL when the parent swaps to another project', async () => {
    const wrapper = mount(GitHubIssuesSourceForm, {
      props: { modelValue: { owner: 'julianjab', repo: 'accountant' } },
    })
    await wrapper.setProps({ modelValue: { owner: 'la-haus', repo: 'ia-flow' } })
    const input = wrapper.findAll('input')[0].element as HTMLInputElement
    expect(input.value).toBe('https://github.com/la-haus/ia-flow')
  })
})
