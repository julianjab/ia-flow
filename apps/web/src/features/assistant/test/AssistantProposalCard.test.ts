import type { AssistantProposal } from '@ia-flow/shared'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { useGithubSessionStore } from '@/stores/githubSession'
import AssistantProposalCard from '../AssistantProposalCard.vue'

const issue: AssistantProposal = {
  id: 'i1',
  kind: 'issue',
  repo: 'julianjab/ia-flow',
  title: 'Cortar el loop del reviewer',
  body: '## Problema\nSe re-dispara.',
  labels: ['runner'],
  label: 'Abrir un issue en julianjab/ia-flow',
  reason: 'falló tres veces igual',
}

function card(props: Record<string, unknown>) {
  const pinia = createPinia()
  setActivePinia(pinia)
  useGithubSessionStore().github = { token: 'gho_1', login: 'ada' }
  return mount(AssistantProposalCard, { props, global: { plugins: [pinia] } })
}

describe('AssistantProposalCard', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('un issue propuesto muestra título, repo, labels y su cuerpo, y se abre con un botón', async () => {
    const wrapper = card({ proposal: issue, status: 'open' })
    expect(wrapper.text()).toContain('issue propuesto')
    expect(wrapper.get('[data-test="issue-title"]').text()).toBe('Cortar el loop del reviewer')
    expect(wrapper.text()).toContain('julianjab/ia-flow')
    expect(wrapper.text()).toContain('runner')
    expect(wrapper.get('[data-test="issue-body"]').text()).toContain('Se re-dispara.')
    const run = wrapper.get('[data-test="run"]')
    expect(run.text()).toBe('Abrir issue')
    await run.trigger('click')
    expect(wrapper.emitted('run')).toHaveLength(1)
  })

  it('abierto, linkea al issue', () => {
    const wrapper = card({
      proposal: issue,
      status: 'done',
      message: 'julianjab/ia-flow#77 abierto',
      url: 'https://github.com/julianjab/ia-flow/issues/77',
    })
    const link = wrapper.get('a')
    expect(link.attributes('href')).toBe('https://github.com/julianjab/ia-flow/issues/77')
    expect(link.text()).toBe('julianjab/ia-flow#77 abierto')
    expect(wrapper.find('[data-test="run"]').exists()).toBe(false)
  })
})
