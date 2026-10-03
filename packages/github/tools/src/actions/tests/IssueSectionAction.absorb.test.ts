import { createEvent, EventBus, type PipelineExecutionContext } from '@ia-flow/agent-engine'
import { GithubClient } from '@ia-flow/github-api'
import { GithubTokenAuth } from '@ia-flow/github-auth'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { IssueSectionAction, ORIGINAL_BODY_MARKER } from '../IssueSectionAction.js'
import { wrapSection } from '../issueSection.js'

const ISSUE = { owner: 'la-haus', repo: 'subscriptions', number: 1727 }
const URL = 'https://api.github.com/repos/la-haus/subscriptions/issues/1727'

const ctx = (): PipelineExecutionContext => ({
  event: createEvent('e', ISSUE),
  steps: {},
  bus: new EventBus(),
  pipelineId: 'p',
})

/** Un issue en memoria que anota, EN ORDEN, cada escritura (comentario o body). */
function fakeIssue(initialBody: string, options: { failComment?: boolean } = {}) {
  let body = initialBody
  const writes: string[] = []
  const comments: string[] = []
  const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET'
    if (url === `${URL}/comments` && method === 'POST') {
      if (options.failComment) return new Response('boom', { status: 500 })
      writes.push('comment')
      comments.push((JSON.parse(init.body as string) as { body: string }).body)
      return new Response(JSON.stringify({ html_url: 'c' }), { status: 201 })
    }
    expect(url).toBe(URL)
    if (method === 'PATCH') {
      writes.push('body')
      body = (JSON.parse(init.body as string) as { body: string }).body
    }
    return new Response(JSON.stringify({ body }), { status: 200 })
  })
  const client = new GithubClient({
    auth: new GithubTokenAuth('t'),
    fetchImpl: fetchImpl as unknown as typeof fetch,
  })
  return { client, writes, comments, body: () => body }
}

const Prd = z.strictObject({ objetivo: z.string().min(1) })
const section = {
  id: 'prd',
  title: 'PRD técnico',
  schema: Prd,
  render: (data: z.infer<typeof Prd>) => `## 🎯 Objetivo\n${data.objetivo}`,
}

const HUMAN = '## Contexto\nSeparar crm.\n\n## Criterios de aceptación\n- [ ] Algo.'

describe('IssueSectionAction with original: absorb', () => {
  it("saves the person's description as a comment and leaves the PRD as the whole body", async () => {
    const issue = fakeIssue(HUMAN)
    await new IssueSectionAction({ client: issue.client, section, original: 'absorb' }).run(ctx(), {
      objetivo: 'Que X',
    })

    // The comment goes first: if the body write fails, nothing was lost.
    expect(issue.writes).toEqual(['comment', 'body'])
    expect(issue.comments[0]).toContain(ORIGINAL_BODY_MARKER)
    expect(issue.comments[0]).toContain('### Descripción original')
    expect(issue.comments[0]).toContain('## Criterios de aceptación\n- [ ] Algo.')
    expect(issue.body()).toBe(wrapSection('prd', '## 🎯 Objetivo\nQue X') + '\n')
    expect(issue.body()).not.toContain('Contexto')
  })

  it('keeps the other blocks (the Slack thread) and only drops what is outside every block', async () => {
    const slack = wrapSection('slack', '## Slack\nhilo')
    const issue = fakeIssue(`${HUMAN}\n\n${slack}\n`)
    await new IssueSectionAction({ client: issue.client, section, original: 'absorb' }).run(ctx(), {
      objetivo: 'Que X',
    })
    expect(issue.body()).toContain(slack)
    expect(issue.body()).toContain('## 🎯 Objetivo')
    expect(issue.body()).not.toContain('Separar crm')
    expect(issue.comments[0]).not.toContain('hilo')
  })

  it('is idempotent: a body that is already only blocks posts no second comment', async () => {
    const issue = fakeIssue(HUMAN)
    const action = new IssueSectionAction({ client: issue.client, section, original: 'absorb' })
    await action.run(ctx(), { objetivo: 'Que X' })
    await action.run(ctx(), { objetivo: 'Que Y' })
    expect(issue.comments).toHaveLength(1)
    expect(issue.body()).toContain('Que Y')
  })

  it('a description written by a person after the first run is absorbed again', async () => {
    const issue = fakeIssue(HUMAN)
    const action = new IssueSectionAction({ client: issue.client, section, original: 'absorb' })
    await action.run(ctx(), { objetivo: 'Que X' })
    // Someone adds text outside the block.
    await issue.client.requestJson(URL, {
      method: 'PATCH',
      body: JSON.stringify({ body: `Nota nueva.\n\n${issue.body()}` }),
    })
    await action.run(ctx(), { objetivo: 'Que X' })
    expect(issue.comments).toHaveLength(2)
    expect(issue.comments[1]).toContain('Nota nueva.')
  })

  it('an empty body or one that is only blocks posts nothing', async () => {
    const issue = fakeIssue('')
    await new IssueSectionAction({ client: issue.client, section, original: 'absorb' }).run(ctx(), {
      objetivo: 'Que X',
    })
    expect(issue.comments).toEqual([])
    expect(issue.writes).toEqual(['body'])
  })

  it('does not touch the body when it cannot post the comment', async () => {
    const issue = fakeIssue(HUMAN, { failComment: true })
    await expect(
      new IssueSectionAction({ client: issue.client, section, original: 'absorb' }).run(ctx(), {
        objetivo: 'Que X',
      }),
    ).rejects.toThrow()
    expect(issue.writes).toEqual([])
    expect(issue.body()).toBe(HUMAN)
  })

  it('the tool description tells the model its PRD is now the whole body', () => {
    const { client } = fakeIssue('')
    const absorbing = new IssueSectionAction({ client, section, original: 'absorb' })
    expect(absorbing.description).toContain('body COMPLETO')
    expect(absorbing.description).toContain('cubrir todo lo que ella pedía')
  })
})

describe('IssueSectionAction default (keep)', () => {
  it('leaves the description above the block and posts no comment', async () => {
    const issue = fakeIssue(HUMAN)
    await new IssueSectionAction({ client: issue.client, section }).run(ctx(), {
      objetivo: 'Que X',
    })
    expect(issue.comments).toEqual([])
    expect(issue.body().startsWith(HUMAN)).toBe(true)
    expect(issue.body()).toContain('## 🎯 Objetivo')
  })
})
