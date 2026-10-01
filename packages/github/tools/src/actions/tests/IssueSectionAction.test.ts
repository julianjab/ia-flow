import { createEvent, EventBus, type PipelineExecutionContext } from '@ia-flow/agent-engine'
import { GithubClient } from '@ia-flow/github-api'
import { GithubTokenAuth } from '@ia-flow/github-auth'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { CheckSectionItemsAction } from '../CheckSectionItemsAction.js'
import { IssueSectionAction } from '../IssueSectionAction.js'
import { wrapSection } from '../issueSection.js'

const ISSUE = { owner: 'la-haus', repo: 'subscriptions', number: 42 }
const ISSUE_URL = 'https://api.github.com/repos/la-haus/subscriptions/issues/42'

function ctxFor(payload: Record<string, unknown> = ISSUE): PipelineExecutionContext {
  return { event: createEvent('e', payload), steps: {}, bus: new EventBus(), pipelineId: 'p' }
}

/** Un issue en memoria: GET devuelve el body actual, PATCH lo reemplaza. */
function fakeIssue(initialBody: string | null) {
  let body = initialBody
  const patches: string[] = []
  const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
    expect(url).toBe(ISSUE_URL)
    if ((init.method ?? 'GET') === 'PATCH') {
      body = (JSON.parse(init.body as string) as { body: string }).body
      patches.push(body)
    }
    return new Response(JSON.stringify({ body }), { status: 200 })
  })
  const client = new GithubClient({
    auth: new GithubTokenAuth('t'),
    fetchImpl: fetchImpl as unknown as typeof fetch,
  })
  return { client, patches, body: () => body }
}

const Prd = z.strictObject({
  objetivo: z.string().min(1),
  zona: z.array(z.string()).min(1),
})

const section = {
  id: 'prd',
  title: 'PRD técnico',
  schema: Prd,
  render: (data: z.infer<typeof Prd>) =>
    `## 🎯 Objetivo\n${data.objetivo}\n\n## Zona\n${wrapSection(
      'prd.zona',
      data.zona.map((item) => `- [ ] ${item}`).join('\n'),
    )}`,
}

describe('IssueSectionAction', () => {
  it('renders the validated data into its block, below the human description', async () => {
    const issue = fakeIssue('Lo que pidió el humano.')

    const result = await new IssueSectionAction({ client: issue.client, section }).run(ctxFor(), {
      objetivo: 'Que X',
      zona: ['`a.ts` — uno'],
    })

    expect(result).toMatch(/^PRD técnico actualizado en la-haus\/subscriptions#42/)
    expect(issue.body()).toBe(
      'Lo que pidió el humano.\n\n<!-- ia-flow:prd -->\n## 🎯 Objetivo\nQue X\n\n## Zona\n<!-- ia-flow:prd.zona -->\n- [ ] `a.ts` — uno\n<!-- /ia-flow:prd.zona -->\n<!-- /ia-flow:prd -->\n',
    )
  })

  it('rewrites the whole block on the next call and keeps the rest', async () => {
    const issue = fakeIssue(`arriba\n\n${wrapSection('prd', 'viejo')}\n\nabajo`)

    await new IssueSectionAction({ client: issue.client, section }).run(ctxFor(), {
      objetivo: 'nuevo',
      zona: ['b'],
    })

    expect(issue.body()).toMatch(/^arriba\n\n<!-- ia-flow:prd -->\n## 🎯 Objetivo\nnuevo/)
    expect(issue.body()).toMatch(/<!-- \/ia-flow:prd -->\n\nabajo$/)
    expect(issue.body()).not.toContain('viejo')
  })

  it('keeps the progress another agent ticked when the block is rewritten', async () => {
    const issue = fakeIssue(
      wrapSection('prd', `## Zona\n${wrapSection('prd.zona', '- [x] a\n- [ ] b')}`),
    )

    await new IssueSectionAction({ client: issue.client, section }).run(ctxFor(), {
      objetivo: 'corregido',
      zona: ['a', 'b', 'c'],
    })

    expect(issue.body()).toContain('- [x] a\n- [ ] b\n- [ ] c')
  })

  it('rejects data outside the schema before reading the issue', async () => {
    const issue = fakeIssue('x')

    await expect(
      new IssueSectionAction({ client: issue.client, section }).run(ctxFor(), {
        objetivo: 'X',
        zona: [],
        extra: 'no',
      }),
    ).rejects.toThrow(/update_prd: input inválido/)
    expect(issue.patches).toEqual([])
  })

  it('is named after its section and writes, so it needs allowWrite', () => {
    const action = new IssueSectionAction({
      client: fakeIssue('').client,
      section: { ...section, id: 'prd-funcional' },
    })

    expect(action.id).toBe('update_prd_funcional')
    expect(action.sideEffects).toBe('write')
    expect(action.asTool(ctxFor()).inputSchema).toMatchObject({
      required: ['objetivo', 'zona'],
      additionalProperties: false,
    })
  })
})

describe('CheckSectionItemsAction', () => {
  const written = `humano\n\n${wrapSection('prd', `## Zona\n${wrapSection('prd.zona', '- [ ] a\n- [ ] b')}`)}\n`

  it('ticks items and answers with the state of the whole list', async () => {
    const issue = fakeIssue(written)
    const action = new CheckSectionItemsAction({
      client: issue.client,
      section: 'prd.zona',
      title: 'la Zona de impacto',
    })

    const result = await action.run(ctxFor(), { items: [2] })

    expect(action.id).toBe('check_prd_zona')
    expect(issue.body()).toBe(written.replace('- [ ] b', '- [x] b'))
    expect(result).toBe('Tildados: 2 — 1/2 hechos\n1. [ ] a\n2. [x] b')
  })

  it('does not write when an item does not exist', async () => {
    const issue = fakeIssue(written)

    await expect(
      new CheckSectionItemsAction({ client: issue.client, section: 'prd.zona', title: 'z' }).run(
        ctxFor(),
        { items: [3] },
      ),
    ).rejects.toThrow(/tiene 2 ítems — no existen: 3/)
    expect(issue.patches).toEqual([])
  })
})
