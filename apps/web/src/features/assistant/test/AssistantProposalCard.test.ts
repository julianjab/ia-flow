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

  describe('issue para el board', () => {
    const boardIssue: AssistantProposal = {
      ...issue,
      id: 'b1',
      board: { project_id: 'core', status: 'Refine' },
    } as AssistantProposal
    const statuses = ['Todo', 'Refine', 'Build']

    it('muestra repo, título, cuerpo y la columna propuesta; confirma con la elegida', async () => {
      const wrapper = card({ proposal: boardIssue, status: 'open', statuses })
      expect(wrapper.get('[data-test="issue-title"]').text()).toBe('Cortar el loop del reviewer')
      expect(wrapper.text()).toContain('julianjab/ia-flow')
      expect(wrapper.get('[data-test="issue-body"]').text()).toContain('Se re-dispara.')
      const select = wrapper.get<HTMLSelectElement>('[data-test="board-column"]')
      expect(select.findAll('option').map((o) => o.text())).toEqual(statuses)
      expect(select.element.value).toBe('Refine')
      const run = wrapper.get('[data-test="run"]')
      expect(run.text()).toBe('Crear y agregar al board')

      await select.setValue('Build')
      await run.trigger('click')
      expect(wrapper.emitted('run')).toEqual([[{ status: 'Build' }]])
    })

    it('sin columna propuesta (o una que el board no tiene) preselecciona Todo', () => {
      const wrapper = card({
        proposal: { ...boardIssue, board: { project_id: 'core', status: 'Nope' } },
        status: 'open',
        statuses: ['Backlog', 'To do', 'Done'],
      })
      expect(wrapper.get<HTMLSelectElement>('[data-test="board-column"]').element.value).toBe(
        'To do',
      )
    })

    it('sin las columnas del proyecto no hay selector y se manda la propuesta tal cual', async () => {
      const wrapper = card({ proposal: boardIssue, status: 'open' })
      expect(wrapper.find('[data-test="board-column"]').exists()).toBe(false)
      expect(wrapper.get('[data-test="board"]').text()).toBe('→ Refine · core')
      await wrapper.get('[data-test="run"]').trigger('click')
      expect(wrapper.emitted('run')).toEqual([[{ status: 'Refine' }]])
    })

    it('las columnas que llegan después preseleccionan la propuesta', async () => {
      const wrapper = card({ proposal: boardIssue, status: 'open' })
      await wrapper.setProps({ statuses })
      expect(wrapper.get<HTMLSelectElement>('[data-test="board-column"]').element.value).toBe(
        'Refine',
      )
    })

    it('hecho: dice en qué columna quedó y linkea el issue', () => {
      const wrapper = card({
        proposal: boardIssue,
        status: 'done',
        statuses,
        message: 'julianjab/ia-flow#77 abierto',
        url: 'https://github.com/julianjab/ia-flow/issues/77',
        boardStatus: 'Build',
      })
      const done = wrapper.get('[data-test="done"]')
      expect(done.text().replace(/\s+/g, ' ')).toBe('✓ julianjab/ia-flow#77 abierto y en Build')
      expect(done.get('a').attributes('href')).toBe(
        'https://github.com/julianjab/ia-flow/issues/77',
      )
      expect(wrapper.find('[data-test="board-column"]').exists()).toBe(false)
      expect(wrapper.find('[data-test="board-error"]').exists()).toBe(false)
    })

    it('abierto pero fuera del board: link al issue, el motivo y ningún botón para reintentar', () => {
      const wrapper = card({
        proposal: boardIssue,
        status: 'done',
        url: 'https://github.com/julianjab/ia-flow/issues/78',
        boardError: 'sin permisos en el Project',
      })
      const done = wrapper.get('[data-test="done"]')
      expect(done.text().replace(/\s+/g, ' ')).toBe('✓ julianjab/ia-flow#78 abierto')
      expect(done.get('a').attributes('href')).toBe(
        'https://github.com/julianjab/ia-flow/issues/78',
      )
      expect(wrapper.get('[data-test="board-error"]').text()).toContain(
        'sin permisos en el Project',
      )
      expect(wrapper.find('[data-test="run"]').exists()).toBe(false)
      expect(wrapper.find('button').exists()).toBe(false)
    })
  })
})
