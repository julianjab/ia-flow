import type { SourceItem } from '@/features/projects/sourceApi'
import ItemReposModal from '@/features/repos/ItemReposModal.vue'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import TareasSection from '../TareasSection.vue'

const items: SourceItem[] = []

vi.mock('@/features/projects/store', () => ({
  useProjectsStore: () => ({ activeProjectId: 'p1' }),
}))
vi.mock('@/stores/toast', () => ({
  useToastStore: () => ({ success: vi.fn(), error: vi.fn() }),
}))
const repoEntries: Array<Record<string, unknown>> = []
vi.mock('@/features/repos/api', () => ({
  getRepoMappings: vi.fn(async () => repoEntries),
}))
const requestSlackReview = vi.fn(async () => ({
  kind: 'first' as const,
  channel: 'C1',
  reviewers: [{ id: 'U1', name: 'juli' }],
  prNumber: 7,
  threadUrl: 'https://acme.slack.com/archives/C1/p1699999999123456',
}))
vi.mock('@/features/tasks/api', () => ({
  requestSlackReview: (...args: unknown[]) => requestSlackReview(...(args as [])),
}))
const statuses: Array<{ name: string }> = [{ name: 'refine' }, { name: 'doing' }, { name: 'done' }]
// Vacío por default; los tests de "bloqueada" cargan entradas por itemId.
const blockersById: Record<string, Array<Record<string, unknown>>> = {}
vi.mock('@/features/projects/sourceApi', () => ({
  fetchProjectItems: vi.fn(async () => ({ kind: 'github-issues', items })),
  fetchProjectStatuses: vi.fn(async () => ({ kind: 'github-issues', statuses })),
  fetchItemBlockers: vi.fn(async (_projectId: string, itemId: string) => ({
    kind: 'github-issues',
    blockers: blockersById[itemId] ?? [],
  })),
  setProjectItemField: vi.fn(async () => {}),
}))

// El componente lee los filtros de la query y los escribe con `replace`; el
// test controla las dos puntas sin montar un router real.
let routeQuery: Record<string, string | string[]> = {}
const routerReplace = vi.fn()
vi.mock('vue-router', () => ({
  useRoute: () => ({
    get query() {
      return routeQuery
    },
  }),
  useRouter: () => ({ replace: routerReplace }),
}))

beforeEach(() => {
  routeQuery = {}
  routerReplace.mockClear()
  localStorage.clear()
  for (const key of Object.keys(blockersById)) delete blockersById[key]
})

function githubItem(meta: Record<string, unknown>): SourceItem {
  return {
    id: 'I_1',
    title: 'Do the thing',
    status: 'refine',
    repos: 'ia-flow',
    url: 'https://github.com/la-haus/ia-flow/issues/42',
    meta: { issueNumber: 42, ...meta },
  }
}

async function mountWith(list: SourceItem[]) {
  items.splice(0, items.length, ...list)
  const wrapper = mount(TareasSection)
  await flushPromises()
  return wrapper
}

describe('TareasSection — dev links', () => {
  it('linkea el número de issue al item en la plataforma del provider', async () => {
    const wrapper = await mountWith([githubItem({ pullRequests: [] })])
    const link = wrapper.get('.task-number-link')
    expect(link.attributes('href')).toBe('https://github.com/la-haus/ia-flow/issues/42')
    expect(link.attributes('target')).toBe('_blank')
  })

  it('el número queda fuera del texto que trunca y el título lleva su tooltip', async () => {
    const wrapper = await mountWith([githubItem({ pullRequests: [] })])
    // El link vive en su propio nodo: truncar el título nunca se come el #42.
    expect(wrapper.get('.task-number-link').text()).toBe('#42↗')
    expect(wrapper.get('.task-title').attributes('title')).toBe('Do the thing')
  })

  it('muestra la rama remota como link y el PR con su estado', async () => {
    const wrapper = await mountWith([
      githubItem({
        linkedBranch: 'fix/algo',
        branchUrl: 'https://github.com/la-haus/ia-flow/tree/fix%2Falgo',
        pullRequests: [
          {
            number: 7,
            url: 'https://github.com/la-haus/ia-flow/pull/7',
            state: 'merged',
            isDraft: false,
          },
        ],
      }),
    ])
    const branch = wrapper.get('.tag--branch')
    expect(branch.text()).toContain('fix/algo')
    expect(branch.attributes('href')).toBe('https://github.com/la-haus/ia-flow/tree/fix%2Falgo')
    const pr = wrapper.get('.tag--pr')
    expect(pr.text()).toContain('PR #7')
    expect(pr.classes()).toContain('is-merged')
    expect(wrapper.find('.tag-empty').exists()).toBe(false)
  })

  it('marca explícitamente la ausencia de rama y de PR', async () => {
    const wrapper = await mountWith([githubItem({ pullRequests: [] })])
    const empties = wrapper.findAll('.tag-empty').map((e) => e.text())
    expect(empties).toEqual(['sin rama', 'sin PR'])
  })

  it('un PR en draft se rotula draft, no por su state', async () => {
    const wrapper = await mountWith([
      githubItem({
        pullRequests: [{ number: 9, url: 'u', state: 'open', isDraft: true }],
      }),
    ])
    const pr = wrapper.get('.tag--pr')
    expect(pr.text()).toContain('PR #9')
    expect(pr.classes()).toContain('is-draft')
  })

  it('providers sin noción de ramas/PRs no dicen nada de ramas ni PRs', async () => {
    const wrapper = await mountWith([
      { id: 'L_1', title: 'Local task', status: 'queued', repos: 'algo' },
    ])
    expect(wrapper.find('.tag--branch').exists()).toBe(false)
    expect(wrapper.find('.tag--pr').exists()).toBe(false)
    expect(wrapper.find('.tag-empty').exists()).toBe(false)
  })

  it('los tags de repo, rama y PR viven en la misma fila, sin botón de editar', async () => {
    const wrapper = await mountWith([
      githubItem({
        linkedBranch: 'fix/algo',
        pullRequests: [{ number: 7, url: 'u', state: 'open', isDraft: false }],
      }),
    ])
    const row = wrapper.get('.task-tags-row')
    expect(row.findAll('.tag--repo').map((c) => c.text())).toEqual(['ia-flow'])
    expect(row.findAll('.tag--branch')).toHaveLength(1)
    expect(row.findAll('.tag--pr')).toHaveLength(1)
    expect(wrapper.find('.btn-edit').exists()).toBe(false)
  })
})

describe('TareasSection — detalle', () => {
  it('le pasa los dev links al modal de detalle', async () => {
    const wrapper = await mountWith([
      githubItem({
        linkedBranch: 'fix/algo',
        branchUrl: 'https://github.com/la-haus/ia-flow/tree/fix/algo',
        pullRequests: [{ number: 7, url: 'u', state: 'open', isDraft: false }],
      }),
    ])
    await wrapper.get('.task-card').trigger('click')
    const modal = wrapper.findComponent(ItemReposModal)
    expect(modal.props('branch')).toBe('fix/algo')
    expect(modal.props('devLinks')).toBe(true)
    expect(modal.props('issueUrl')).toBe('https://github.com/la-haus/ia-flow/issues/42')
    expect(modal.props('pullRequests')).toHaveLength(1)
  })
})

// ─── Pedido de review en Slack ─────────────────────────────────────────────

const OPEN_PR_GREEN = {
  number: 7,
  url: 'https://github.com/o/r/pull/7',
  state: 'open' as const,
  isDraft: false,
  ci: 'success' as const,
}

function withReviewers() {
  repoEntries.splice(0, repoEntries.length, {
    name: 'ia-flow',
    slackReviewChannel: 'C1',
    slackReviewers: [{ id: 'U1', name: 'juli' }],
  })
}

describe('TareasSection — pedido de review en Slack', () => {
  beforeEach(() => {
    requestSlackReview.mockClear()
    repoEntries.splice(0, repoEntries.length)
  })

  it('con PR abierto, CI verde y reviewers, el botón está habilitado', async () => {
    withReviewers()
    const wrapper = await mountWith([githubItem({ pullRequests: [OPEN_PR_GREEN] })])
    const btn = wrapper.get('.task-slack-btn')
    expect(btn.attributes('disabled')).toBeUndefined()
    expect(btn.text()).toContain('Solicitar review')
  })

  // El motivo va en el title: el operador tiene que poder saber por qué está
  // apagado sin abrir nada.
  it('sin nada configurado queda deshabilitado y nombra el canal faltante', async () => {
    const wrapper = await mountWith([githubItem({ pullRequests: [OPEN_PR_GREEN] })])
    const btn = wrapper.get('.task-slack-btn')
    expect(btn.attributes('disabled')).toBeDefined()
    expect(btn.attributes('title')).toMatch(/canal/i)
  })

  it('con canal pero sin reviewers nombra los reviewers faltantes', async () => {
    repoEntries.splice(0, repoEntries.length, { name: 'ia-flow', slackReviewChannel: 'C1' })
    const wrapper = await mountWith([githubItem({ pullRequests: [OPEN_PR_GREEN] })])
    const btn = wrapper.get('.task-slack-btn')
    expect(btn.attributes('disabled')).toBeDefined()
    expect(btn.attributes('title')).toMatch(/reviewers/i)
  })

  it('con el CI corriendo queda deshabilitado', async () => {
    withReviewers()
    const wrapper = await mountWith([
      githubItem({ pullRequests: [{ ...OPEN_PR_GREEN, ci: 'pending' }] }),
    ])
    const btn = wrapper.get('.task-slack-btn')
    expect(btn.attributes('disabled')).toBeDefined()
    expect(btn.attributes('title')).toMatch(/CI/)
  })

  it('sin PR abierto queda deshabilitado', async () => {
    withReviewers()
    const wrapper = await mountWith([
      githubItem({ pullRequests: [{ ...OPEN_PR_GREEN, state: 'merged' }] }),
    ])
    expect(wrapper.get('.task-slack-btn').attributes('disabled')).toBeDefined()
  })

  it('una tarea que ya pidió review ofrece el re-review', async () => {
    withReviewers()
    const wrapper = await mountWith([
      githubItem({
        pullRequests: [OPEN_PR_GREEN],
        slackThreadUrl: 'https://acme.slack.com/archives/C1/p1699999999123456',
      }),
    ])
    expect(wrapper.get('.task-slack-btn').text()).toContain('Pedir re-review')
  })

  it('el click pide el review sin abrir el modal de repos', async () => {
    withReviewers()
    const wrapper = await mountWith([githubItem({ pullRequests: [OPEN_PR_GREEN] })])
    await wrapper.get('.task-slack-btn').trigger('click')
    await flushPromises()
    expect(requestSlackReview).toHaveBeenCalledWith('p1', 'I_1', { allowFailedCi: false })
    expect(wrapper.findComponent(ItemReposModal).props('open')).toBe(false)
  })

  // El CI en rojo no bloquea, pero no sale sin que alguien lo decida.
  it('con el CI en rojo pide confirmación antes de publicar', async () => {
    withReviewers()
    const wrapper = await mountWith([
      githubItem({ pullRequests: [{ ...OPEN_PR_GREEN, ci: 'failure' }] }),
    ])
    await wrapper.get('.task-slack-btn').trigger('click')
    await flushPromises()
    expect(requestSlackReview).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('CI en rojo')
  })
})

// ─── Filtros del listado ───────────────────────────────────────────────────

const MERGED_PR = { number: 7, url: 'u', state: 'merged' as const, isDraft: false }
const OPEN_PR = { number: 8, url: 'u', state: 'open' as const, isDraft: false }

function item(id: string, status: string, meta: Record<string, unknown> = {}): SourceItem {
  return { id, title: `Tarea ${id}`, status, repos: 'ia-flow', meta }
}

/** El board típico: dos terminadas con su PR mergeado y una todavía viva. */
const BOARD: SourceItem[] = [
  item('I_1', 'done', { pullRequests: [MERGED_PR] }),
  item('I_2', 'done', { pullRequests: [MERGED_PR] }),
  item('I_3', 'doing', { pullRequests: [OPEN_PR], linkedBranch: 'task/3' }),
]

function titles(wrapper: { findAll: (s: string) => Array<{ text: () => string }> }) {
  return wrapper.findAll('.task-title').map((t) => t.text())
}

/** Escribe `campo:valor` en el input de filtros y elige la opción sugerida —
 *  la misma interacción que Ejecuciones/Logs (`FilterQueryInput`). */
async function applyFilter(
  wrapper: Awaited<ReturnType<typeof mountWith>>,
  field: string,
  value: string,
) {
  await wrapper.get('[data-testid="task-filters-input"]').setValue(`${field}:${value}`)
  await wrapper.get(`[data-testid="task-filters-option-${value}"]`).trigger('mousedown')
}

function removeFilter(
  wrapper: Awaited<ReturnType<typeof mountWith>>,
  field: string,
  value: string,
) {
  return wrapper.get(`[data-testid="task-filters-token-${field}-${value}"]`).trigger('click')
}

describe('TareasSection — filtros del listado', () => {
  it('el header cuenta N de M y N refleja lo filtrado', async () => {
    const wrapper = await mountWith(BOARD)
    expect(wrapper.get('[data-testid="task-count"]').text()).toBe('3 de 3 tareas')
    await applyFilter(wrapper, 'pr', 'mergeado')
    expect(wrapper.get('[data-testid="task-count"]').text()).toBe('2 de 3 tareas')
  })

  it('"pr:mergeado" deja sólo las que ya se mergearon', async () => {
    const wrapper = await mountWith(BOARD)
    await applyFilter(wrapper, 'pr', 'mergeado')
    expect(titles(wrapper)).toEqual(['Tarea I_1', 'Tarea I_2'])
  })

  it('sacar el token vuelve a mostrar todo', async () => {
    const wrapper = await mountWith(BOARD)
    await applyFilter(wrapper, 'pr', 'mergeado')
    expect(titles(wrapper)).toHaveLength(2)
    await removeFilter(wrapper, 'pr', 'mergeado')
    expect(titles(wrapper)).toHaveLength(3)
  })

  it('los filtros componen en AND', async () => {
    const wrapper = await mountWith(BOARD)
    await applyFilter(wrapper, 'status', 'doing')
    await applyFilter(wrapper, 'status', 'done')
    await applyFilter(wrapper, 'rama', 'con-branch')
    expect(titles(wrapper)).toEqual(['Tarea I_3'])
  })

  it('deseleccionar el último status vuelve a "sin restricción"', async () => {
    const wrapper = await mountWith(BOARD)
    await applyFilter(wrapper, 'status', 'doing')
    expect(titles(wrapper)).toEqual(['Tarea I_3'])
    await removeFilter(wrapper, 'status', 'doing')
    expect(titles(wrapper)).toHaveLength(3)
  })

  it('un vacío por filtro se distingue de un board sin tareas', async () => {
    const wrapper = await mountWith(BOARD)
    await applyFilter(wrapper, 'pr', 'sin-pr')
    await applyFilter(wrapper, 'status', 'refine')
    expect(wrapper.find('.task-card').exists()).toBe(false)
    expect(wrapper.text()).toContain('coincide con los filtros activos')
    expect(wrapper.text()).not.toContain('No hay tareas para este proyecto')
  })

  it('hidrata desde la URL — el link compartido reproduce la vista', async () => {
    routeQuery = { status: 'doing' }
    const wrapper = await mountWith(BOARD)
    expect(titles(wrapper)).toEqual(['Tarea I_3'])
    expect(wrapper.find('[data-testid="task-filters-token-status-doing"]').exists()).toBe(true)
  })

  it('escribe la selección en la URL', async () => {
    const wrapper = await mountWith(BOARD)
    await applyFilter(wrapper, 'pr', 'mergeado')
    expect(routerReplace).toHaveBeenCalledWith({ query: { pr: ['mergeado'] } })
  })

  it('sin query en la URL, una entrada en frío recupera lo último elegido', async () => {
    localStorage.setItem('ia-flow:task-filters:p1', 'rama=con-branch')
    const wrapper = await mountWith(BOARD)
    expect(titles(wrapper)).toEqual(['Tarea I_3'])
  })

  it('un provider sin noción de PRs no deja tareas fantasma bajo "pr:sin-pr"', async () => {
    const wrapper = await mountWith([
      {
        id: 'L_1',
        title: 'Local task',
        status: 'doing',
        repos: 'algo',
        meta: { pullRequestsKnown: false },
      },
      ...BOARD,
    ])
    expect(titles(wrapper)).toContain('Local task')
    await applyFilter(wrapper, 'pr', 'sin-pr')
    expect(titles(wrapper)).not.toContain('Local task')
  })

  it('"bloqueada:si" deja sólo las tareas con blockers sin resolver', async () => {
    blockersById.I_3 = [{ id: 'B_1', title: 'depende de otro issue' }]
    const wrapper = await mountWith(BOARD)
    await applyFilter(wrapper, 'bloqueada', 'si')
    expect(titles(wrapper)).toEqual(['Tarea I_3'])
  })

  it('"bloqueada:no" es el complemento', async () => {
    blockersById.I_3 = [{ id: 'B_1', title: 'depende de otro issue' }]
    const wrapper = await mountWith(BOARD)
    await applyFilter(wrapper, 'bloqueada', 'no')
    expect(titles(wrapper)).toEqual(['Tarea I_1', 'Tarea I_2'])
  })
})
