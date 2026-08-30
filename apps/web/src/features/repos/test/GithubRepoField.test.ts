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

// Las sugerencias reales, sin el “usar «…»” del valor propio ni las notas:
// eso es cromo del ComboBox y no lo que este campo decide mostrar.
const opciones = (w: ReturnType<typeof mount>) =>
  w.findAll('.cb-opt:not(.cb-opt--custom) .cb-opt__label').map((e) => e.text())

// Lo elegido se lee del chip. El input queda para lo que se está tipeando.
const elegido = (w: ReturnType<typeof mount>) =>
  w.find('.cb-chip__text').exists() ? w.get('.cb-chip__text').text() : ''

// El ComboBox no emite por tecla: confirma al salir del campo. Es a propósito
// — un `julianjab` a medio escribir no es un repo.
const escribir = async (w: ReturnType<typeof mount>, v: string) => {
  await w.get('input').setValue(v)
  await w.get('input').trigger('blur')
}

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
    await escribir(wrapper, 'https://github.com/julianjab/accountant')
    expect(lastEmit(wrapper)).toEqual({ owner: 'julianjab', repo: 'accountant' })
  })

  it('shows the saved pair as owner/repo', () => {
    const wrapper = mount(GithubRepoField, {
      props: { owner: 'julianjab', repo: 'accountant' },
    })
    expect(elegido(wrapper)).toBe('julianjab/accountant')
  })

  it('suggests owners until one is typed, then that owner repos', async () => {
    const wrapper = mount(GithubRepoField, { props: { owner: '', repo: '' } })
    await flush()
    await wrapper.get('input').trigger('focus')
    expect(opciones(wrapper)).toEqual(['julianjab/', 'la-haus/'])

    await wrapper.get('input').setValue('julianjab/')
    await flush()
    expect(getRepos).toHaveBeenCalledWith('julianjab')
    expect(opciones(wrapper)).toEqual(['julianjab/accountant', 'julianjab/world-clock'])
  })

  it('asks GitHub for nothing until the owner is closed with a slash', async () => {
    const wrapper = mount(GithubRepoField, { props: { owner: '', repo: '' } })
    await flush()
    getRepos.mockClear()

    await wrapper.get('input').setValue('j')
    await wrapper.get('input').setValue('ju')
    await wrapper.get('input').setValue('julianjab')
    await flush()

    expect(getRepos).not.toHaveBeenCalled()
    // Y el buscador de owners sigue vivo mientras tanto.
    await wrapper.get('input').trigger('focus')
    expect(opciones(wrapper)).toEqual(['julianjab/'])
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
    await escribir(wrapper, 'julianjab')
    expect(wrapper.find('.grf-error').exists()).toBe(true)
    expect(lastEmit(wrapper)).toEqual({ owner: '', repo: '' })
  })

  it('keeps the typed text when the parent echoes back the empty pair', async () => {
    const wrapper = mount(GithubRepoField, {
      props: { owner: 'julianjab', repo: 'accountant' },
    })
    await escribir(wrapper, 'julianjab/')
    await wrapper.setProps({ owner: '', repo: '' })
    expect(elegido(wrapper)).toBe('julianjab/')
  })

  it('resyncs when the parent opens another repo card', async () => {
    const wrapper = mount(GithubRepoField, {
      props: { owner: 'julianjab', repo: 'accountant' },
    })
    await wrapper.setProps({ owner: 'la-haus', repo: 'ia-flow' })
    expect(elegido(wrapper)).toBe('la-haus/ia-flow')
  })

  it('drops a slow response for an owner that is no longer being typed', async () => {
    let resolveFirst: (v: { repos: string[] }) => void = () => {}
    getRepos.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve
        }),
    )
    const wrapper = mount(GithubRepoField, { props: { owner: '', repo: '' } })

    await wrapper.get('input').setValue('la-haus/')
    await wrapper.get('input').setValue('julianjab/')
    await flush()
    resolveFirst({ repos: ['ia-flow'] })
    await flush()

    await wrapper.get('input').trigger('focus')
    expect(opciones(wrapper)).toEqual(['julianjab/accountant', 'julianjab/world-clock'])
  })

  it('never shows the previous owner repos while a new owner is loading', async () => {
    const wrapper = mount(GithubRepoField, { props: { owner: '', repo: '' } })
    await wrapper.get('input').setValue('julianjab/')
    await flush()

    getRepos.mockImplementationOnce(() => new Promise(() => {})) // nunca resuelve
    await wrapper.get('input').setValue('la-haus/')
    await flush()

    await wrapper.get('input').trigger('focus')
    // Con `loadedOwner` marcado antes del fetch, `options` durante esta ventana
    // era ['la-haus/accountant', 'la-haus/world-clock'] — repos que no existen
    // en ese owner.
    expect(wrapper.text()).not.toContain('accountant')
    expect(wrapper.text()).toContain('Buscando')
  })

  it('reloads an owner the user came back to while another request was in flight', async () => {
    const wrapper = mount(GithubRepoField, { props: { owner: '', repo: '' } })
    await wrapper.get('input').setValue('julianjab/')
    await flush()
    getRepos.mockClear()

    // Tipear `julianjabx` y volver a `julianjab` antes de que responda.
    let resolveStale: (v: { repos: string[] }) => void = () => {}
    getRepos.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStale = resolve
        }),
    )
    await wrapper.get('input').setValue('julianjabx/')
    await wrapper.get('input').setValue('julianjab/')
    resolveStale({ repos: ['otro'] })
    await flush()
    await flush()

    await wrapper.get('input').trigger('focus')
    expect(opciones(wrapper)).toEqual(['julianjab/accountant', 'julianjab/world-clock'])
  })

  it('clears the list when an owner lookup fails, instead of relabelling the previous one', async () => {
    const wrapper = mount(GithubRepoField, { props: { owner: '', repo: '' } })
    await wrapper.get('input').setValue('julianjab/')
    await flush()

    getRepos.mockRejectedValueOnce(new Error('404'))
    await wrapper.get('input').setValue('nope/')
    await flush()

    await wrapper.get('input').trigger('focus')
    // Sin limpiar, las sugerencias serían 'nope/accountant' y 'nope/world-clock':
    // los repos del owner anterior renombrados al que acaba de fallar.
    expect(opciones(wrapper)).toHaveLength(0)
  })
})
