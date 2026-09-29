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
} from '@ia-tools/agent-pipeline'
import { type MountedRunner, mountRunner } from '../boot.js'
import { loadRunnerConfig } from '../config/RunnerConfig.js'
import { CONFIG_DIR } from './helpers.js'

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
}

export interface FakePr {
  number: number
  state?: string
  body?: string
  head: { ref: string; sha: string }
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
      api.calls.push(`graphql ${query.match(/(node|projectItems|reviewThreads)/)?.[1] ?? '?'}`)
      return json(api.graphql(query, variables))
    }
    api.calls.push(`${init.method ?? 'GET'} ${url.pathname}${url.search}`)
    return api.rest(url.pathname, url.searchParams)
  }) as typeof fetch
  return { fetch: fetchImpl, calls: api.calls }
}

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
    if (query.includes('reviewThreads')) {
      return { data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }
    }
    return { errors: [{ message: `query desconocida: ${query.slice(0, 40)}` }] }
  }

  rest(path: string, search: URLSearchParams): Response {
    const [, owner = '', repo = '', rest = ''] =
      path.match(/^\/repos\/([^/]+)\/([^/]+)\/(.+)$/) ?? []
    const issue = rest.match(/^issues\/(\d+)(\/.*)?$/)
    if (issue) return this.issue(owner, repo, issue[1] as string, issue[2])
    const pull = rest.match(/^pulls\/(\d+)(\/reviews)?$/)
    if (pull) return pull[2] ? json([]) : json(this.pull(owner, repo, pull[1] as string))
    if (rest === 'pulls') return json(this.openFrom(owner, repo, search.get('head') ?? ''))
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

  private openFrom(owner: string, repo: string, head: string) {
    return Object.entries(this.data.prs ?? {})
      .filter(
        ([key, pr]) => key.startsWith(`${owner}/${repo}#`) && `${owner}:${pr.head.ref}` === head,
      )
      .map(([, pr]) => prJson(owner, repo, pr))
      .filter((pr) => pr.state === 'open')
  }
}

function prJson(owner: string, repo: string, pr: FakePr) {
  return {
    number: pr.number,
    state: pr.state ?? 'open',
    body: pr.body ?? '',
    head: pr.head,
    html_url: `https://github.com/${owner}/${repo}/pull/${pr.number}`,
  }
}

/** El runner en dry-run con esta GitHub simulada (y, si se pasa, este clasificador de
 *  `whenText`; si no, el de dry-run, que dice que sí). */
export function mountWith(
  github: FakeGithub,
  textClassifier?: TextClassifier,
  dir = CONFIG_DIR,
): Promise<MountedRunner> {
  return mountRunner(loadRunnerConfig(dir), {
    dryRun: true,
    live: false,
    log: () => {},
    githubFetch: github.fetch,
    ...(textClassifier ? { textClassifier } : {}),
  })
}

/** Los pasos de `pipeline` que corren para `event` por su `when` — a qué agente va. */
export function stepsFor(pipeline: Pipeline, event: DomainEvent): string[] {
  const ctx = { event, steps: {}, bus: new EventBus(), pipelineId: pipeline.id }
  return pipeline.do.filter((step) => step.shouldRun(ctx)).map((step) => step.id ?? '?')
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
  const engine = new Engine({ bus, pipelines: new StaticPipelineSource(mounted.intake()) })
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
