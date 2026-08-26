import { beforeEach, describe, expect, it } from 'bun:test'
import type { IRepoRepository } from '@ia-flow/agent-engine'
import type { IssueItem, ProjectSource, SourceItem } from '@ia-flow/issue-sources'
import type { Project, PullRequestRef } from '@ia-flow/shared'
import {
  RequestSlackReviewUseCase,
  type SlackPostPort,
  SlackReviewError,
} from '../RequestSlackReviewUseCase.js'

// Ports falsos escritos a mano — el use-case no toca DB ni red.

const JULI = { id: 'U1', name: 'juli' }
const BOT = { id: 'B2', name: 'reviewer-bot', isBot: true }
const THREAD = 'https://acme.slack.com/archives/C1/p1699999999123456'

function pr(over: Partial<PullRequestRef> = {}): PullRequestRef {
  return {
    number: 7,
    url: 'https://github.com/o/r/pull/7',
    nodeId: 'PR_1',
    state: 'open',
    isDraft: false,
    ci: 'success',
    ...over,
  }
}

interface SourceStub extends ProjectSource {
  saved: string[]
}

function makeSource(over: Partial<ProjectSource> & { prs?: PullRequestRef[] } = {}): SourceStub {
  const saved: string[] = []
  const item: SourceItem = {
    id: 't1',
    title: 'Tarea',
    status: 'Review',
    repos: 'ia-flow',
    meta: { pullRequests: over.prs ?? [pr()] },
  }
  const base = {
    kind: 'github-projects',
    saved,
    getStatuses: async () => [],
    getItems: async () => [item],
    getItemById: async () => item,
    toIssueItem: (i: SourceItem): IssueItem => ({
      id: i.id,
      title: i.title,
      description: '',
      type: '',
      status: i.status,
      repos: (i.repos ?? '')
        .split(',')
        .map((r) => r.trim())
        .filter(Boolean),
      meta: i.meta,
    }),
    watch: () => ({ dispose() {} }),
    getSlackThreadUrl: async () => undefined,
    setSlackThreadUrl: async (_i: IssueItem, url: string) => {
      saved.push(url)
    },
  }
  const { prs: _prs, ...rest } = over
  return { ...base, ...rest } as SourceStub
}

function makeRepoRepo(entry: Record<string, unknown> | null): IRepoRepository {
  return { getByProject: () => entry } as unknown as IRepoRepository
}

const project = (settings: Record<string, unknown> = {}): Project => ({
  id: 'p1',
  name: 'ia-flow',
  settings,
})

let posted: Array<{ channel: string; text: string; thread_ts?: string }>
let slack: SlackPostPort

beforeEach(() => {
  posted = []
  slack = {
    postMessage: async (input) => {
      posted.push(input)
      return { channel: 'C1', ts: '1699999999.123456' }
    },
    getPermalink: async () => THREAD,
  }
})

function useCase(opts: {
  repo?: Record<string, unknown> | null
  settings?: Record<string, unknown>
  slack?: SlackPostPort
}) {
  return new RequestSlackReviewUseCase(
    makeRepoRepo(
      opts.repo === undefined ? { slackChannel: 'C1', slackReviewers: [JULI] } : opts.repo,
    ),
    { get: () => project(opts.settings ?? {}) },
    opts.slack ?? slack,
  )
}

const input = { projectId: 'p1', taskId: 't1' }

describe('RequestSlackReviewUseCase', () => {
  it('primer pedido: abre hilo, taguea y guarda el link', async () => {
    const source = makeSource()
    const res = await useCase({}).execute(input, source)

    expect(res.kind).toBe('first')
    expect(posted[0].channel).toBe('C1')
    expect(posted[0].thread_ts).toBeUndefined()
    expect(posted[0].text).toContain('<@U1> porfavor revisar y aprobar este PR')
    expect(res.threadUrl).toBe(THREAD)
    expect(source.saved).toEqual([THREAD])
  })

  // Lo que hace que el revisor no pierda el contexto: el segundo pedido cae
  // dentro del hilo, y no se vuelve a guardar el link.
  it('re-review: postea DENTRO del hilo existente', async () => {
    const source = makeSource({ getSlackThreadUrl: async () => THREAD })
    const res = await useCase({}).execute(input, source)

    expect(res.kind).toBe('re-review')
    expect(posted[0].thread_ts).toBe('1699999999.123456')
    expect(posted[0].text).toBe('<@U1> se realizaron las correcciones porfavor revisar.')
    expect(source.saved).toEqual([])
  })

  it('sin PR abierto no se pide nada', async () => {
    const source = makeSource({ prs: [pr({ state: 'merged' })] })
    await expect(useCase({}).execute(input, source)).rejects.toThrow(SlackReviewError)
    expect(posted).toHaveLength(0)
  })

  it('con el CI corriendo no se pide nada', async () => {
    const source = makeSource({ prs: [pr({ ci: 'pending' })] })
    await expect(useCase({}).execute(input, source)).rejects.toThrow(/corriendo/)
    expect(posted).toHaveLength(0)
  })

  // El CI rojo no bloquea, pero exige que alguien lo haya decidido.
  it('con el CI en rojo exige allowFailedCi', async () => {
    const source = makeSource({ prs: [pr({ ci: 'failure' })] })
    await expect(useCase({}).execute(input, source)).rejects.toThrow(/failure/)

    const res = await useCase({}).execute({ ...input, allowFailedCi: true }, source)
    expect(res.kind).toBe('first')
  })

  it('sin reviewers ni en el repo ni en el proyecto no se pide nada', async () => {
    const source = makeSource()
    await expect(useCase({ repo: { slackChannel: 'C1' } }).execute(input, source)).rejects.toThrow(
      /reviewers/,
    )
  })

  it('hereda canal y reviewers del proyecto', async () => {
    const source = makeSource()
    const res = await useCase({
      repo: null,
      settings: { slackReviewChannel: 'C_PROJ', slackReviewers: [BOT] },
    }).execute(input, source)

    expect(posted[0].channel).toBe('C_PROJ')
    expect(res.reviewers).toEqual([BOT])
  })

  // El mensaje ya salió: fallar el request dejaría al operador creyendo que no
  // se pidió nada.
  it('si no se puede guardar el link, el pedido igual sale (con aviso)', async () => {
    const source = makeSource({
      setSlackThreadUrl: async () => {
        throw new Error('campo inexistente')
      },
    })
    const res = await useCase({}).execute(input, source)
    expect(posted).toHaveLength(1)
    expect(res.threadNotPersisted).toContain('campo inexistente')
  })

  it('una fuente que no sabe guardar el hilo publica igual', async () => {
    const source = makeSource({ setSlackThreadUrl: undefined })
    const res = await useCase({}).execute(input, source)
    expect(posted).toHaveLength(1)
    expect(res.threadNotPersisted).toContain('no guarda el link')
  })
})
