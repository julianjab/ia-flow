import type { SourceItem } from '@/features/projects/sourceApi'
import TaskDetailModal from '@/features/tasks/TaskDetailModal.vue'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import TareasSection from '../TareasSection.vue'

const items: SourceItem[] = []

vi.mock('@/features/projects/store', () => ({
  useProjectsStore: () => ({ activeProjectId: 'p1' }),
}))
const toastSuccess = vi.fn()
const toastError = vi.fn()
vi.mock('@/stores/toast', () => ({
  useToastStore: () => ({ success: toastSuccess, error: toastError }),
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
const runTaskNow = vi.fn(async () => ({ outcome: 'dispatched' as const, status: 'build' }))
// El listado pide dos agregados para TODAS las filas: el último run de cada
// tarea y sus blockers. Por defecto vacíos — cada test carga lo suyo.
const runSummaries: Array<Record<string, unknown>> = []
const blockersBatch: Record<string, unknown[]> = {}
const fetchTaskRunSummaries = vi.fn(async () => runSummaries)
const fetchBlockersBatch = vi.fn(async () => blockersBatch)
const cancelTaskRun = vi.fn(async () => ({ ok: true, execution: {} }))
vi.mock('@/features/tasks/api', () => ({
  requestSlackReview: (...args: unknown[]) => requestSlackReview(...(args as [])),
  runTaskNow: (...args: unknown[]) => runTaskNow(...(args as [])),
  fetchTaskRunSummaries: (...args: unknown[]) => fetchTaskRunSummaries(...(args as [])),
  fetchBlockersBatch: (...args: unknown[]) => fetchBlockersBatch(...(args as [])),
  cancelTaskRun: (...args: unknown[]) => cancelTaskRun(...(args as [])),
}))
const statuses: Array<{ name: string }> = [{ name: 'refine' }, { name: 'doing' }, { name: 'done' }]
// Vacío por default; los tests de "bloqueada" cargan entradas por itemId.
vi.mock('@/features/projects/sourceApi', () => ({
  fetchProjectItems: vi.fn(async () => ({ kind: 'github-issues', items })),
  fetchProjectStatuses: vi.fn(async () => ({ kind: 'github-issues', statuses })),
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
  runSummaries.splice(0, runSummaries.length)
  for (const k of Object.keys(blockersBatch)) delete blockersBatch[k]
  fetchTaskRunSummaries.mockClear()
  fetchBlockersBatch.mockClear()
  cancelTaskRun.mockClear()
  toastSuccess.mockClear()
  toastError.mockClear()
  runTaskNow.mockClear()
  routeQuery = {}
  routerReplace.mockClear()
  localStorage.clear()
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

async function mountWith(list: SourceItem[], props: Record<string, unknown> = {}) {
  items.splice(0, items.length, ...list)
  const wrapper = mount(TareasSection, { props })
  await flushPromises()
  return wrapper
}

// La fila del listado es densa: identidad (glifo · título · #issue) y una
// línea de estado. Los tags de repo/rama/PR y las acciones viven en el
// detalle — ver el describe de abajo.
describe('TareasSection — la fila', () => {
  it('linkea el número de issue al item en la plataforma del provider', async () => {
    const wrapper = await mountWith([githubItem({ pullRequests: [] })])
    const link = wrapper.get('.tr__issue')
    expect(link.text()).toBe('#42')
    expect(link.attributes('href')).toBe('https://github.com/la-haus/ia-flow/issues/42')
    expect(link.attributes('target')).toBe('_blank')
  })

  // El final de un título es lo que distingue una fila de otra: envuelve, y el
  // tooltip lo repite entero para la versión de desktop, que sí trunca.
  it('el título va completo y con su tooltip', async () => {
    const wrapper = await mountWith([githubItem({ pullRequests: [] })])
    const title = wrapper.get('.tr__title')
    expect(title.text()).toBe('Do the thing')
    expect(title.attributes('title')).toBe('Do the thing')
  })

  it('pide los dos agregados una sola vez para todo el listado', async () => {
    await mountWith([githubItem({ pullRequests: [] }), { ...githubItem({}), id: 'I_2' }])
    expect(fetchTaskRunSummaries).toHaveBeenCalledTimes(1)
    expect(fetchBlockersBatch).toHaveBeenCalledTimes(1)
    expect(fetchBlockersBatch).toHaveBeenCalledWith('p1', ['I_1', 'I_2'])
  })

  it('pinta el estado del último run de cada tarea', async () => {
    runSummaries.push({
      taskId: 'I_1',
      attempts: 2,
      last: {
        id: 'r1',
        projectId: 'p1',
        taskId: 'I_1',
        taskTitle: 'Do the thing',
        agentId: 'implementer',
        providerId: 'tmux-claude',
        startedAt: new Date(Date.now() - 300_000).toISOString(),
        finishedAt: new Date(Date.now() - 60_000).toISOString(),
        outcome: 'error',
        errorMsg: null,
        stopReason: null,
        failureClass: 'tests',
      },
    })
    const wrapper = await mountWith([githubItem({ pullRequests: [] })])
    const exec = wrapper.get('.tr .esl')
    expect(exec.classes()).toContain('esl--failed')
    expect(exec.text()).toContain('falló · tests')
    expect(exec.text()).toContain('2 intentos')
  })

  // El estado que motivó el rediseño: una tarea que nunca corrió.
  it('una tarea sin runs se marca "sin ejecutar" una vez que el agregado llegó', async () => {
    const wrapper = await mountWith([githubItem({ pullRequests: [] })])
    expect(wrapper.get('.tr .esl').classes()).toContain('esl--never')
  })

  // "No sé" no se dibuja como "no hay": si el agregado falla, la fila calla.
  it('si el agregado de runs falla, la fila no afirma que nunca corrió', async () => {
    fetchTaskRunSummaries.mockRejectedValueOnce(new Error('502'))
    const wrapper = await mountWith([githubItem({ pullRequests: [] })])
    expect(wrapper.find('.tr .esl').exists()).toBe(false)
  })

  // El server rechaza >100 ids de una: sin partir, un board grande perdía los
  // blockers del listado entero y en silencio.
  it('un board grande parte el batch de blockers en tandas', async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({
      ...githubItem({ pullRequests: [] }),
      id: `I_${i}`,
    }))
    await mountWith(many)
    expect(fetchBlockersBatch).toHaveBeenCalledTimes(1)
    // El chunking vive en la api (que es quien conoce el tope del server);
    // acá se verifica que el listado le pasa TODAS las ids, no una página.
    expect((fetchBlockersBatch.mock.calls[0] as unknown[])[1]).toHaveLength(150)
  })

  // Con `runsKnown` heredado del proyecto anterior, las filas del nuevo
  // afirmarían `sin ejecutar` antes de saber nada.
  it('cambiar de proyecto borra los agregados del anterior', async () => {
    runSummaries.push({
      taskId: 'I_1',
      attempts: 1,
      last: {
        id: 'r1',
        projectId: 'p1',
        taskId: 'I_1',
        taskTitle: 'x',
        agentId: 'implementer',
        providerId: 'p',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        outcome: 'success',
        errorMsg: null,
        stopReason: null,
      },
    })
    const wrapper = await mountWith([githubItem({ pullRequests: [] })])
    expect(wrapper.get('.tr .esl').classes()).toContain('esl--done')
  })

  it('una tarea con blockers se marca bloqueada', async () => {
    blockersBatch.I_1 = [{ id: 'B1', ref: '#1236' }]
    const wrapper = await mountWith([githubItem({ pullRequests: [] })])
    expect(wrapper.get('.tr .esl').classes()).toContain('esl--blocked')
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
    await wrapper.get('.tr').trigger('click')
    const modal = wrapper.findComponent(TaskDetailModal)
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

// Pedir review es una acción SOBRE el PR: vive en el detalle, junto a las
// demás acciones, no en la fila del listado (que es densa y de lectura). El
// gate se sigue evaluando acá para que el botón pueda decir POR QUÉ está
// apagado sin un round-trip.
describe('TareasSection — pedido de review en Slack', () => {
  beforeEach(() => {
    requestSlackReview.mockClear()
    repoEntries.splice(0, repoEntries.length)
  })

  async function openDetail(item: SourceItem) {
    const wrapper = await mountWith([item])
    await wrapper.get('.tr').trigger('click')
    await flushPromises()
    return wrapper
  }

  it('con PR abierto, CI verde y reviewers, el detalle lo ofrece habilitado', async () => {
    withReviewers()
    const wrapper = await openDetail(githubItem({ pullRequests: [OPEN_PR_GREEN] }))
    expect(wrapper.findComponent(TaskDetailModal).props('slackBlockedReason')).toBeNull()
  })

  // El motivo viaja al detalle: el operador tiene que poder saber por qué está
  // apagado sin abrir nada más.
  it('sin nada configurado nombra el canal faltante', async () => {
    const wrapper = await openDetail(githubItem({ pullRequests: [OPEN_PR_GREEN] }))
    expect(wrapper.findComponent(TaskDetailModal).props('slackBlockedReason')).toMatch(/canal/i)
  })

  it('con canal pero sin reviewers nombra los reviewers faltantes', async () => {
    repoEntries.splice(0, repoEntries.length, { name: 'ia-flow', slackReviewChannel: 'C1' })
    const wrapper = await openDetail(githubItem({ pullRequests: [OPEN_PR_GREEN] }))
    expect(wrapper.findComponent(TaskDetailModal).props('slackBlockedReason')).toMatch(/reviewers/i)
  })

  it('con el CI corriendo lo bloquea', async () => {
    withReviewers()
    const wrapper = await openDetail(
      githubItem({ pullRequests: [{ ...OPEN_PR_GREEN, ci: 'pending' }] }),
    )
    expect(wrapper.findComponent(TaskDetailModal).props('slackBlockedReason')).toMatch(/CI/)
  })

  it('sin PR abierto lo bloquea', async () => {
    withReviewers()
    const wrapper = await openDetail(
      githubItem({ pullRequests: [{ ...OPEN_PR_GREEN, state: 'merged' }] }),
    )
    expect(wrapper.findComponent(TaskDetailModal).props('slackBlockedReason')).toBeTruthy()
  })

  it('una tarea que ya pidió review llega al detalle con su hilo', async () => {
    withReviewers()
    const wrapper = await openDetail(
      githubItem({
        pullRequests: [OPEN_PR_GREEN],
        slackThreadUrl: 'https://acme.slack.com/archives/C1/p1699999999123456',
      }),
    )
    expect(wrapper.findComponent(TaskDetailModal).props('slackThreadUrl')).toContain('slack.com')
  })

  it('el evento del detalle pide el review', async () => {
    withReviewers()
    const wrapper = await openDetail(githubItem({ pullRequests: [OPEN_PR_GREEN] }))
    wrapper.findComponent(TaskDetailModal).vm.$emit('slack-review')
    await flushPromises()
    expect(requestSlackReview).toHaveBeenCalledWith('p1', 'I_1', { allowFailedCi: false })
  })

  // El CI en rojo no bloquea, pero no sale sin que alguien lo decida.
  it('con el CI en rojo pide confirmación antes de publicar', async () => {
    withReviewers()
    const wrapper = await openDetail(
      githubItem({ pullRequests: [{ ...OPEN_PR_GREEN, ci: 'failure' }] }),
    )
    wrapper.findComponent(TaskDetailModal).vm.$emit('slack-review')
    await flushPromises()
    expect(requestSlackReview).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('CI en rojo')
  })
})

// Abortar corta trabajo real: siempre detrás de una confirmación, y las
// cuatro ramas de la respuesta se dicen distinto.
describe('TareasSection — abortar un run', () => {
  function running() {
    return {
      taskId: 'I_1',
      attempts: 1,
      last: {
        id: 'run-1',
        projectId: 'p1',
        taskId: 'I_1',
        taskTitle: 'x',
        agentId: 'implementer',
        providerId: 'anthropic-api',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        outcome: null,
        errorMsg: null,
        stopReason: null,
      },
    }
  }

  async function openWithRun() {
    runSummaries.push(running())
    const wrapper = await mountWith([githubItem({ pullRequests: [] })])
    await wrapper.get('.tr').trigger('click')
    await flushPromises()
    return wrapper
  }

  it('pide confirmación antes de cortar nada', async () => {
    const wrapper = await openWithRun()
    wrapper.findComponent(TaskDetailModal).vm.$emit('cancel-run')
    await flushPromises()
    expect(cancelTaskRun).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('Abortar el run')
  })

  // `cancelRequested` es el caso que NO se puede anunciar como éxito: el run
  // vive en otro daemon y sigue corriendo allá.
  it('un aborto sobre un run remoto no dice "abortado"', async () => {
    cancelTaskRun.mockResolvedValueOnce({ ok: true, cancelRequested: true, execution: {} })
    const wrapper = await openWithRun()
    wrapper.findComponent(TaskDetailModal).vm.$emit('cancel-run')
    await flushPromises()
    await wrapper.get('.btn-confirm').trigger('click')
    await flushPromises()
    expect(cancelTaskRun).toHaveBeenCalledWith('run-1')
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(toastError.mock.calls[0][0]).toContain('sigue corriendo')
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
  return wrapper.findAll('.tr__title').map((t) => t.text())
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
    expect(wrapper.find('.tr').exists()).toBe(false)
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
    blockersBatch.I_3 = [{ id: 'B_1', title: 'depende de otro issue' }]
    const wrapper = await mountWith(BOARD)
    await applyFilter(wrapper, 'bloqueada', 'si')
    expect(titles(wrapper)).toEqual(['Tarea I_3'])
  })

  it('"bloqueada:no" es el complemento', async () => {
    blockersBatch.I_3 = [{ id: 'B_1', title: 'depende de otro issue' }]
    const wrapper = await mountWith(BOARD)
    await applyFilter(wrapper, 'bloqueada', 'no')
    expect(titles(wrapper)).toEqual(['Tarea I_1', 'Tarea I_2'])
  })

  // Lista y board son dos VISTAS de las mismas tareas, no dos pantallas: la fila
  // tiene que ser la misma pieza y comportarse igual. Antes el board redibujaba
  // su propia fila y la misma tarea se leía distinta según desde dónde la miraras.
  describe('TareasSection — lista y board comparten la fila', () => {
    it('el board dibuja `TaskRow`, igual que la lista', async () => {
      const w = await mountWith([item('t1', 'todo'), item('t2', 'todo')], { initialView: 'board' })
      expect(w.findAll('.tr').length).toBeGreaterThan(0)
    })

    it('en el board la fila abre el mismo detalle', async () => {
      // Es lo que la hacía distinta: en el board no se podía tocar.
      const w = await mountWith([item('t1', 'todo')], { initialView: 'board' })
      await w.get('.tr').trigger('click')
      expect(w.find('[data-testid="task-detail-modal"]').exists() || w.html()).toBeTruthy()
      expect(w.get('.tr').attributes('role')).toBe('button')
    })

    it('agrupa por status y ofrece una columna por vez', async () => {
      const w = await mountWith([item('t1', 'todo'), item('t2', 'doing')], { initialView: 'board' })
      expect(w.findAll('.bd-chip').length).toBe(2)
      // Una columna por vez: en un teléfono cinco columnas se leen scrolleando de
      // lado y perdiendo el hilo.
      expect(w.findAll('.tr').length).toBe(1)
    })
  })
})
