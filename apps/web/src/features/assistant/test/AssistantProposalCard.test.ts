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

  it('mover: dice de qué columna a cuál, abre la tarea y se confirma con «Mover»', async () => {
    const wrapper = card({
      proposal: {
        id: 'm1',
        kind: 'move',
        ref: 'o/r#1',
        status: 'Refine',
        from: 'Build',
        label: 'Mover a Refine',
        reason: 'falta el PRD',
      },
      status: 'open',
    })
    expect(wrapper.text()).toContain('mover la card')
    expect(wrapper.get('[data-test="move"]').text()).toBe('Build → Refine')
    await wrapper.get('[data-test="open-o/r#1"]').trigger('click')
    expect(wrapper.emitted('open')).toEqual([['o/r#1']])
    const run = wrapper.get('[data-test="run"]')
    expect(run.text()).toBe('Mover')
    await run.trigger('click')
    expect(wrapper.emitted('run')).toHaveLength(1)
  })

  it('sumar al board: linkea el issue en GitHub (no está en la bandeja) y dice a qué columna', () => {
    const wrapper = card({
      proposal: {
        id: 'a1',
        kind: 'add_to_board',
        issue: 'o/r#9',
        project_id: 'p',
        label: 'Agregar al board',
        reason: 'lo pidió producto',
      },
      status: 'open',
    })
    expect(wrapper.get('[data-test="issue-link"]').attributes('href')).toBe(
      'https://github.com/o/r/issues/9',
    )
    expect(wrapper.get('[data-test="add"]').text()).toBe('→ columna de entrada · p')
    expect(wrapper.get('[data-test="run"]').text()).toBe('Agregar al board')
  })

  it('labels: muestra los que van y los que salen; hecho, dice qué cambió', () => {
    const proposal: AssistantProposal = {
      id: 'l1',
      kind: 'labels',
      ref: 'o/r#1',
      add: ['e2e-test'],
      remove: ['blocked'],
      label: 'Poner e2e-test y sacar blocked',
      reason: 'ya se contestó',
    }
    const open = card({ proposal, status: 'open' })
    expect(open.findAll('[data-test="labels"] span').map((tag) => tag.text())).toEqual([
      '+ e2e-test',
      '− blocked',
    ])
    expect(open.get('[data-test="run"]').text()).toBe('Aplicar')

    const done = card({ proposal, status: 'done', message: 'labels: +e2e-test, -blocked' })
    expect(done.text()).toContain('✓ Aplicado · labels: +e2e-test, -blocked')
    expect(done.find('[data-test="run"]').exists()).toBe(false)
  })
})
