import { createEvent, EventBus, type PipelineExecutionContext } from '@ia-flow/agent-engine'
import { GithubClient } from '@ia-flow/github-api'
import { GithubTokenAuth } from '@ia-flow/github-auth'
import { describe, expect, it, vi } from 'vitest'
import { LinkBranchAction } from '../LinkBranchAction.js'

const TASK = {
  owner: 'la-haus',
  repo: 'subscriptions',
  number: 1640,
  task: { branch: 'ia-flow-local/1640' },
}

function ctxFor(payload: Record<string, unknown> = TASK): PipelineExecutionContext {
  return { event: createEvent('e', payload), steps: {}, bus: new EventBus(), pipelineId: 'p' }
}

interface State {
  linked?: string[]
  remoteRef?: boolean
  issue?: boolean
}

/** Un GitHub falso que responde el query de ramas y registra la mutación. */
function fakeGithub(state: State = {}) {
  const queries: Array<{ query: string; variables: Record<string, unknown> }> = []
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string)
    queries.push(body)
    if (body.query.includes('createLinkedBranch')) {
      return new Response(
        JSON.stringify({
          data: { createLinkedBranch: { linkedBranch: { ref: { name: body.variables.name } } } },
        }),
      )
    }
    return new Response(
      JSON.stringify({
        data: {
          repository: {
            id: 'R_repo',
            defaultBranchRef: { target: { oid: 'abc123' } },
            ref: state.remoteRef ? { name: 'ia-flow-local/1640' } : null,
            issue:
              state.issue === false
                ? null
                : {
                    id: 'I_issue',
                    linkedBranches: {
                      nodes: (state.linked ?? []).map((name) => ({ ref: { name } })),
                    },
                  },
          },
        },
      }),
    )
  })
  const client = new GithubClient({
    auth: new GithubTokenAuth('t'),
    fetchImpl: fetchImpl as unknown as typeof fetch,
  })
  const mutations = () => queries.filter((q) => q.query.includes('createLinkedBranch'))
  return { client, queries, mutations }
}

describe('LinkBranchAction', () => {
  it('creates the task branch from the default branch head and links it to the issue', async () => {
    const { client, queries, mutations } = fakeGithub()

    const result = await new LinkBranchAction({ client }).run(ctxFor(), {})

    expect(queries[0]?.variables).toEqual({
      owner: 'la-haus',
      repo: 'subscriptions',
      number: 1640,
      ref: 'refs/heads/ia-flow-local/1640',
    })
    expect(mutations().map((m) => m.variables)).toEqual([
      { issueId: 'I_issue', repositoryId: 'R_repo', oid: 'abc123', name: 'ia-flow-local/1640' },
    ])
    expect(result).toContain('creada desde la default branch y vinculada')
  })

  it('is a no-op when the branch is already linked', async () => {
    const { client, mutations } = fakeGithub({ linked: ['ia-flow-local/1640'] })

    const result = await new LinkBranchAction({ client }).run(ctxFor(), {})

    expect(mutations()).toEqual([])
    expect(result).toContain('ya estaba vinculada')
  })

  it('never recreates a branch that already exists remotely without a link', async () => {
    const { client, mutations } = fakeGithub({ remoteRef: true })

    const result = await new LinkBranchAction({ client }).run(ctxFor(), {})

    expect(mutations()).toEqual([])
    expect(result).toContain('ya existe en el remoto sin vínculo')
  })

  it('fails when the issue does not exist', async () => {
    const { client } = fakeGithub({ issue: false })
    await expect(new LinkBranchAction({ client }).run(ctxFor(), {})).rejects.toThrow(/no existe/)
  })

  it('takes the branch from the event, never from the model, and rejects an unsafe name', async () => {
    const { client, queries } = fakeGithub()
    const action = new LinkBranchAction({ client })

    await expect(action.run(ctxFor({ ...TASK, task: {} }), {})).rejects.toThrow(/task\.branch/)
    await expect(
      action.run(ctxFor({ ...TASK, task: { branch: 'ia-flow-local/../main' } }), {}),
    ).rejects.toThrow(/nombre de rama inválido/)
    await expect(action.run(ctxFor(), { branch: 'otra' } as never)).rejects.toThrow()
    expect(queries).toEqual([])
  })

  it('is a write action', () => {
    expect(new LinkBranchAction({ client: {} as GithubClient }).sideEffects).toBe('write')
  })
})
