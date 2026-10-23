import { createEvent, EventBus, type PipelineExecutionContext } from '@ia-flow/agent-engine'
import { GithubClient } from '@ia-flow/github-api'
import { GithubTokenAuth } from '@ia-flow/github-auth'
import { describe, expect, it, vi } from 'vitest'
import { RetargetPullRequestAction } from '../RetargetPullRequestAction.js'

const EVENT = {
  owner: 'la-haus',
  repo: 'api',
  number: 2,
  pr: { number: 20 },
  from: 'feat/a',
  to: 'main',
}

function ctxFor(payload: Record<string, unknown> = EVENT): PipelineExecutionContext {
  return { event: createEvent('e', payload), steps: {}, bus: new EventBus(), pipelineId: 'p' }
}

/** Un GitHub cuyo PR #20 apunta a `base`, y que anota los PATCH. */
function fakeGithub(base: string) {
  const patches: unknown[] = []
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    if (init.method === 'PATCH') patches.push(JSON.parse(init.body as string))
    return new Response(JSON.stringify({ number: 20, base: { ref: base } }))
  })
  const client = new GithubClient({
    auth: new GithubTokenAuth('t'),
    fetchImpl: fetchImpl as unknown as typeof fetch,
  })
  return { client, patches }
}

describe('RetargetPullRequestAction', () => {
  it('apunta el PR apilado a la rama en la que entró su base', async () => {
    const { client, patches } = fakeGithub('feat/a')

    const result = await new RetargetPullRequestAction({ client }).run(ctxFor(), {})

    expect(patches).toEqual([{ base: 'main' }])
    expect(result).toBe('PR #20: base feat/a → main')
  })

  it('no toca un PR que GitHub ya reapuntó', async () => {
    const { client, patches } = fakeGithub('main')

    expect(await new RetargetPullRequestAction({ client }).run(ctxFor(), {})).toContain(
      'ya apunta a main',
    )
    expect(patches).toEqual([])
  })

  it('no toca un PR que una persona apuntó a otra rama', async () => {
    const { client, patches } = fakeGithub('release')

    expect(await new RetargetPullRequestAction({ client }).run(ctxFor(), {})).toContain(
      'no lo toco',
    )
    expect(patches).toEqual([])
  })

  it('falla sin from/to en el evento', async () => {
    const { client } = fakeGithub('feat/a')
    const { from: _from, ...rest } = EVENT

    await expect(new RetargetPullRequestAction({ client }).run(ctxFor(rest), {})).rejects.toThrow(
      'from/to',
    )
  })
})
