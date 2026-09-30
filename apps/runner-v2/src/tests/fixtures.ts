/**
 * Fixtures del intake: una API de GitHub simulada (el `fetch` del `GithubClient` del runner, con
 * el que lee `resolve_task`) y deliveries crudos de ejemplo. Los tests recorren el intake REAL de
 * `.config/`, sin red.
 */
import {
  createEvent,
  type DomainEvent,
  Engine,
  EventBus,
  type Pipeline,
  StaticPipelineSource,
  type TextClassifier,
} from '@ia-flow/agent-engine'
import { GLOBAL_SOURCE } from '../actions/loader.js'
import { type MountedRunner, mountRunner } from '../boot.js'
import { loadRunnerConfig } from '../config/RunnerConfig.js'
import { CONFIG_DIR, mountForTest } from './helpers.js'

export const BOARD = { owner: 'la-haus', number: 119 }

export const repository = {
  name: 'subscriptions',
  full_name: 'la-haus/subscriptions',
  owner: { login: 'la-haus' },
}

/** Una task en la GitHub simulada: su card (sin `board`, en el de este runner) y su issue. */
export interface FakeTask {
  status?: string
  type?: string
  /** Otro board = la card es de otro engine. `null` = el issue no está en ningún board. */
  board?: { owner: string; number: number } | null
  labels?: string[]
  /** Los issues que la bloquean (abiertos o cerrados). */
  blockedBy?: Array<{ number: number; title: string; state: string; html_url: string }>
  /** Los issues que ella bloquea, como los devuelve `dependencies/blocking`. */
  blocking?: Array<{ number: number; state: string; repository_url: string }>
  comments?: Array<{ body: string; created_at: string; user: { login: string } }>
  /** Las ramas vinculadas al issue (sección "Development"). */
  linkedBranches?: string[]
}

export interface FakePr {
  number: number
  state?: string
  body?: string
  title?: string
  head: { ref: string; sha: string }
  /** El issue que el PR cierra según GitHub (su "Development"), sea cual sea su rama; `null` =
   *  ninguno. Sin declarar, cierra el #7 de la suite. */
  closes?: number | null
}

export interface FakeGithubData {
  /** Por `owner/repo#n`. */
  tasks?: Record<string, FakeTask>
  /** Los items del board por node id → la task (`owner/repo#n`) que envuelven. */
  items?: Record<string, string>
  /** Los PRs por `owner/repo#n` (uno no declarado existe, abierto, desde `feat/x`). */
  prs?: Record<string, FakePr>
  checks?: Array<{ status: string; conclusion: string | null }>
}

export interface FakeGithub {
  fetch: typeof fetch
  /** Lo que se pidió: `GET /repos/...` o `graphql <primera palabra de la query>`. */
  calls: string[]
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const taskKey = (owner: string, repo: string, number: number | string) =>
  `${owner}/${repo}#${number}`

/** Una GitHub en memoria con lo justo que lee el intake. */
export function fakeGithub(data: FakeGithubData = {}): FakeGithub {
  const api = new FakeGithubApi(data)
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input))
    if (url.pathname === '/graphql') {
      const { query, variables } = JSON.parse(String(init.body)) as {
        query: string
        variables: Record<string, unknown>
      }
      api.calls.push(
        `graphql ${query.match(/(closingIssuesReferences|closedByPullRequestsReferences|node|projectItems|reviewThreads)/)?.[1] ?? '?'}`,
      )
      return json(api.graphql(query, variables))
    }
    api.calls.push(`${init.method ?? 'GET'} ${url.pathname}${url.search}`)
    return api.rest(url.pathname)
  }) as typeof fetch
  return { fetch: fetchImpl, calls: api.calls }
}

/** El issue que cierra un PR que el test no declara: la task de la suite. */
const DEFAULT_CLOSES = 7

const NOT_FOUND = () => json({ message: 'Not Found' }, 404)

class FakeGithubApi {
  readonly calls: string[] = []
  private readonly tasks: Record<string, FakeTask>

  constructor(private readonly data: FakeGithubData) {
    this.tasks = data.tasks ?? {}
  }

  graphql(query: string, variables: Record<string, unknown>) {
    if (query.includes('node(id')) return { data: { node: this.node(String(variables.id)) } }
    if (query.includes('projectItems')) {
      const key = taskKey(String(variables.owner), String(variables.repo), String(variables.number))
      const task = this.tasks[key]
      const issue = task ? { projectItems: { nodes: this.items(key, task) } } : null
      return { data: { repository: { issue } } }
    }
    if (query.includes('linkedBranches')) {
      const key = taskKey(String(variables.owner), String(variables.repo), String(variables.number))
      const nodes = (this.tasks[key]?.linkedBranches ?? []).map((name) => ({ ref: { name } }))
      return { data: { repository: { issue: { linkedBranches: { nodes } } } } }
    }
    if (query.includes('closingIssuesReferences')) {
      const pr =
        this.data.prs?.[
          taskKey(String(variables.owner), String(variables.repo), String(variables.number))
        ]
      const closes = pr?.closes === undefined ? DEFAULT_CLOSES : pr.closes
      const nodes =
        closes === null
          ? []
          : [
              {
                number: closes,
                repository: { name: String(variables.repo), owner: { login: variables.owner } },
              },
            ]
      return { data: { repository: { pullRequest: { closingIssuesReferences: { nodes } } } } }
    }
    if (query.includes('closedByPullRequestsReferences')) {
      const nodes = Object.values(this.data.prs ?? {})
        .filter(
          (pr) =>
            (pr.closes === undefined ? DEFAULT_CLOSES : pr.closes) === Number(variables.number),
        )
        .map((pr) => ({ number: pr.number, state: (pr.state ?? 'open').toUpperCase() }))
      return { data: { repository: { issue: { closedByPullRequestsReferences: { nodes } } } } }
    }
    if (query.includes('reviewThreads')) {
      return { data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }
    }
    return { errors: [{ message: `query desconocida: ${query.slice(0, 40)}` }] }
  }

  rest(path: string): Response {
    const [, owner = '', repo = '', rest = ''] =
      path.match(/^\/repos\/([^/]+)\/([^/]+)\/(.+)$/) ?? []
    const issue = rest.match(/^issues\/(\d+)(\/.*)?$/)
    if (issue) return this.issue(owner, repo, issue[1] as string, issue[2])
    const pull = rest.match(/^pulls\/(\d+)(\/reviews)?$/)
    if (pull) return pull[2] ? json([]) : json(this.pull(owner, repo, pull[1] as string))
    if (/^commits\/[^/]+\/check-runs$/.test(rest))
      return json({ check_runs: this.data.checks ?? [] })
    if (/^commits\/[^/]+\/status$/.test(rest)) return json({ statuses: [] })
    return NOT_FOUND()
  }

  /** La card de la task en su board (el de este runner si no dice otro). */
  private items(key: string, task: FakeTask) {
    const board = task.board === undefined ? BOARD : task.board
    if (!board) return []
    const field = (name: string, value?: string) =>
      value ? [{ name: value, field: { name } }] : []
    return [
      {
        id: `PVTI_${key}`,
        project: { number: board.number, owner: { login: board.owner } },
        fieldValues: {
          nodes: [...field('Status', task.status), ...field('Task Type', task.type), {}],
        },
      },
    ]
  }

  private node(id: string) {
    const key = this.data.items?.[id]
    const task = key ? this.tasks[key] : undefined
    const [found] = key && task ? this.items(key, task) : []
    if (!key || !found) return null
    const [owner, repo, number] = key.split(/[/#]/)
    return {
      project: found.project,
      content: { number: Number(number), repository: { name: repo, owner: { login: owner } } },
    }
  }

  private issue(owner: string, repo: string, number: string, sub: string | undefined) {
    const key = taskKey(owner, repo, number)
    const task = this.tasks[key]
    if (sub === '/dependencies/blocked_by') return json(task?.blockedBy ?? [])
    if (sub === '/dependencies/blocking') return json(task?.blocking ?? [])
    if (sub === '/comments') return json(task?.comments ?? [])
    if (sub !== undefined || !task) return NOT_FOUND()
    return json({
      title: `Task ${key}`,
      body: 'el cuerpo',
      html_url: `https://github.com/${owner}/${repo}/issues/${number}`,
      labels: (task.labels ?? ['blocked']).map((name) => ({ name })),
    })
  }

  /** El PR de un webhook existe: uno que el test no declara está abierto, sin rama de task. */
  private pull(owner: string, repo: string, number: string) {
    const pr = this.data.prs?.[taskKey(owner, repo, number)] ?? {
      number: Number(number),
      head: { ref: 'feat/x', sha: 'sha' },
    }
    return prJson(owner, repo, pr)
  }
}

function prJson(owner: string, repo: string, pr: FakePr) {
  return {
    number: pr.number,
    state: pr.state ?? 'open',
    body: pr.body ?? '',
    title: pr.title ?? `PR ${pr.number}`,
    user: { login: 'ai-lh-developer[bot]' },
    head: pr.head,
    base: { ref: 'main' },
    html_url: `https://github.com/${owner}/${repo}/pull/${pr.number}`,
  }
}

/** Los tests no llaman a Haiku: un `whenText` siempre pasa, salvo que el test traiga su clasificador. */
const ALWAYS: TextClassifier = { classify: async () => ({ matches: true, reason: 'test' }) }

/** El runner con esta GitHub simulada y este clasificador de `whenText` (default: siempre pasa). */
export function mountWith(
  github: FakeGithub,
  textClassifier?: TextClassifier,
  dir = CONFIG_DIR,
): Promise<MountedRunner> {
  return mountForTest(dir, { githubFetch: github.fetch, textClassifier: textClassifier ?? ALWAYS })
}

/** Los pasos de `pipeline` que corren para `event` por su `when` — a qué agente va. Con
 *  `firstMatch`, sólo el primero. */
export function stepsFor(pipeline: Pipeline, event: DomainEvent): string[] {
  const ctx = { event, steps: {}, bus: new EventBus(), pipelineId: pipeline.id }
  const due = pipeline.do.filter((step) => step.shouldRun(ctx)).map((step) => step.id ?? '?')
  return pipeline.firstMatch ? due.slice(0, 1) : due
}

/** Las pipelines de la fuente global (`.config/pipelines/`): el intake. */
export function globalPipelines(mounted: MountedRunner): Pipeline[] {
  return mounted.sources.find((entry) => entry.id === GLOBAL_SOURCE)?.source.list() ?? []
}

/**
 * Corre el evento crudo SÓLO por las pipelines de entrada del runner y devuelve lo que publicaron
 * hacia las del proyecto: nada de agentes.
 */
export async function runIntake(
  mounted: MountedRunner,
  event: string,
  payload: Record<string, unknown>,
) {
  const bus = new EventBus()
  const emitted: DomainEvent[] = []
  bus.subscribe('*', (e) => {
    emitted.push(e)
  })
  const engine = new Engine({ bus, pipelines: new StaticPipelineSource(globalPipelines(mounted)) })
  engine.start()
  const outcome = await engine.dispatch(createEvent(`github.${event}`, payload))
  return { outcome, emitted }
}

/** Un item del board (el de la task #7) creado o editado. */
export const itemPayload = (
  action: string,
  fieldValue?: Record<string, unknown>,
  contentType = 'Issue',
) => ({
  action,
  projects_v2_item: { node_id: 'PVTI_1', content_type: contentType },
  ...(fieldValue ? { changes: { field_value: fieldValue } } : {}),
})

export const commentPayload = (body: string, issue: Record<string, unknown> = {}) => ({
  action: 'created',
  issue: { title: 't', body: 'b', number: 7, labels: [{ name: 'backend' }], ...issue },
  comment: { id: 555, body },
  repository,
  sender: { login: 'julian' },
})

export const reviewPayload = (state: string) => ({
  action: 'submitted',
  pull_request: {
    number: 12,
    body: '',
    head: { ref: 'ia-flow-local/7', sha: 's' },
    base: { ref: 'main' },
  },
  review: { state, user: { login: 'rev' }, body: 'arreglá el test' },
  repository,
})

export const runPayload = (action: string, prs: unknown[], branch = 'feat/x') => ({
  action,
  workflow_run: {
    name: 'CI',
    status: 'completed',
    conclusion: 'failure',
    head_branch: branch,
    pull_requests: prs,
  },
  repository,
})
