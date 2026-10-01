import {
  Action,
  ActionStep,
  createEvent,
  type DomainEvent,
  Engine,
  EventBus,
  type PipelineExecutionContext,
  render,
} from '@ia-flow/agent-engine'
import type { Catalogs } from '@ia-flow/agent-engine-definitions'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { sourceDir, yamlSource } from './fixtures.js'

/** La fuente en un engine escuchando su bus; `emitted` junta lo que publican sus pasos. */
function mount(
  files: Record<string, string>,
  catalogs: Catalogs = {},
  vars?: Record<string, unknown>,
) {
  const source = yamlSource({ dir: sourceDir(files), catalogs, ...(vars ? { vars } : {}) })
  const bus = new EventBus()
  const engine = new Engine({ bus, pipelines: source })
  engine.start()
  const emitted: DomainEvent<unknown>[] = []
  bus.subscribe('*', (event) => void emitted.push(event))
  return { source, engine, bus, emitted }
}

/** Por qué falló la única pipeline que corrió (`dispatch` junta los fallos en un AggregateError). */
async function failure(run: Promise<unknown>): Promise<string> {
  const error = await run.then(
    () => undefined,
    (err: unknown) => err,
  )
  return String((error as AggregateError | undefined)?.errors?.[0]?.message ?? 'no falló')
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

describe('templates', () => {
  it('keep the type of a value that is only a template and turn an embedded one into text', () => {
    const root = { issue: { number: 7, labels: ['a'] }, steps: { card: { status: 'Build' } } }

    expect(render('{{issue.number}}', root)).toBe(7)
    expect(render('{{ issue.labels }}', root)).toEqual(['a'])
    expect(render('#{{issue.number}} en {{steps.card.status}}', root)).toBe('#7 en Build')
    expect(render({ n: '{{issue.number}}', list: ['{{missing}}', 'x{{missing}}'] }, root)).toEqual({
      n: 7,
      list: [undefined, 'x'],
    })
  })
})

describe('vars', () => {
  const files = {
    'source.yaml': `
id: flow
vars:
  prefix: ia-flow/
`,
    'pipelines/p.yaml': `
id: p
on: [a]
when:
  - { field: repo, op: in, value: '{{vars.repos}}' }
do:
  - { emit: b, payload: { branch: '{{vars.prefix}}{{number}}', board: '{{vars.board}}' } }
`,
  }

  it('are substituted on load — also in a when — from source.yaml over the app ones', async () => {
    const { engine, emitted } = mount(
      files,
      {},
      {
        repos: ['la-haus/x'],
        prefix: 'pisado/',
        board: { owner: 'la-haus', number: 119 },
      },
    )

    await engine.dispatch(createEvent('a', { repo: 'la-haus/y', number: 1 }))
    await engine.dispatch(createEvent('a', { repo: 'la-haus/x', number: 2 }))

    expect(emitted.filter((e) => e.type === 'b').map((e) => e.payload)).toEqual([
      { branch: 'ia-flow/2', board: { owner: 'la-haus', number: 119 } },
    ])
  })

  it('are substituted before the schema: they fill non-string fields and a wrong type fails the load', async () => {
    const pipeline = (id: string) => `
id: ${id}
on: '{{vars.events}}'
position: '{{vars.position}}'
do:
  - { emit: b }
`
    const vars = { events: ['a', 'c'], position: 5, board: { number: 119 } }
    const { source } = mount({ 'pipelines/p.yaml': pipeline('p') }, {}, vars)
    const [loaded] = source.list()
    expect(loaded?.on).toEqual(['a', 'c'])
    expect(loaded?.position).toBe(5)

    expect(() => mount({ 'pipelines/p.yaml': pipeline("'{{vars.board}}'") }, {}, vars)).toThrow(
      /pipelines\/p\.yaml: inválido/,
    )
  })

  it('a var nobody declares breaks the load', () => {
    expect(() => mount(files, {}, { board: 1 })).toThrow(
      /pipelines\/p\.yaml: no hay una var "repos"/,
    )
  })
})

describe('http', () => {
  const connection = (fetch: typeof globalThis.fetch) => ({
    github: {
      baseUrl: 'https://api.github.com',
      headers: async () => ({ authorization: 'Bearer t' }),
      fetch,
    },
  })

  it('goes to the connection host with its credential, a templated path and query, and keeps what select says', async () => {
    const fetch = vi.fn(async () => json({ data: { number: 9 } }))
    const seen = vi.fn()
    const { engine } = mount(
      {
        'pipelines/p.yaml': `
id: p
on: [a]
do:
  - id: pr
    http: /repos/{{owner}}/{{repo}}/pulls
    connection: github
    query: { head: '{{owner}}:ia-flow/{{number}}', state: open, missing: '{{nope}}' }
    select: data
  - { function: seen, with: { pr: '{{steps.pr}}' } }
`,
      },
      { connections: connection(fetch), functions: { seen } },
    )

    await engine.dispatch(createEvent('a', { owner: 'la-haus', repo: 'x', number: 7 }))

    expect(fetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/la-haus/x/pulls?head=la-haus%3Aia-flow%2F7&state=open',
      expect.objectContaining({
        method: 'GET',
        headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
      }),
    )
    expect(seen.mock.calls[0]?.[1]).toEqual({ pr: { number: 9 } })
  })

  it('a graphql step posts query and variables, reads data, and fails on errors', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ data: { repository: { issue: { id: 'I_1' } } } }))
      .mockResolvedValueOnce(json({ errors: [{ message: 'Could not resolve' }] }))
    const seen = vi.fn()
    const { engine } = mount(
      {
        'pipelines/p.yaml': `
id: p
on: [a]
do:
  - id: issue
    http: /graphql
    connection: github
    graphql: 'query($n: Int!) { repository { issue(number: $n) { id } } }'
    variables: { n: '{{number}}' }
    select: repository.issue
  - { function: seen, with: { id: '{{steps.issue.id}}' } }
`,
      },
      { connections: connection(fetch), functions: { seen } },
    )

    await engine.dispatch(createEvent('a', { number: 7 }))
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({
        query: 'query($n: Int!) { repository { issue(number: $n) { id } } }',
        variables: { n: 7 },
      }),
    })
    expect(seen.mock.calls[0]?.[1]).toEqual({ id: 'I_1' })

    expect(await failure(engine.dispatch(createEvent('a', { number: 8 })))).toMatch(
      /GraphQL — Could not resolve/,
    )
  })

  it('with a connection, the YAML writes the path: a whole-template path does not load', () => {
    expect(() =>
      mount(
        {
          'pipelines/p.yaml': `
id: p
on: [a]
do:
  - { http: '{{path}}', connection: github }
`,
        },
        { connections: connection(vi.fn()) },
      ),
    ).toThrow(/el path no puede ser una plantilla entera/)
  })

  it('a value from the event cannot reach another endpoint of the same host', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => json({}))
    const { engine } = mount(
      {
        'pipelines/p.yaml': `
id: p
on: [a]
do:
  - { http: '/repos/{{owner}}/{{repo}}/issues/{{number}}', connection: github }
`,
      },
      { connections: connection(fetch) },
    )

    // Codificado: no agrega segmentos, ni una query, ni un fragmento.
    await engine.dispatch(createEvent('a', { owner: 'la-haus', repo: 'x/../../orgs?q', number: 1 }))
    expect(fetch.mock.calls[0]?.[0]).toBe(
      'https://api.github.com/repos/la-haus/x%2F..%2F..%2Forgs%3Fq/issues/1',
    )
    for (const payload of [
      { owner: 'la-haus', repo: '..', number: 1 },
      { owner: '%2e%2E', repo: 'x', number: 1 },
    ]) {
      expect(await failure(engine.dispatch(createEvent('a', payload)))).toMatch(
        /no puede ir en un path/,
      )
    }
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('action', () => {
  class Echo extends Action {
    readonly description = 'devuelve su input'
    readonly input = z.strictObject({
      number: z.number(),
      label: z.string(),
      note: z.string().optional(),
    })
    execute(input: z.infer<typeof this.input>, _ctx: PipelineExecutionContext) {
      return input
    }
  }

  it('a templated with is rendered on every run and validated by the action', async () => {
    const seen = vi.fn()
    const { engine } = mount(
      {
        'pipelines/p.yaml': `
id: p
on: [a]
do:
  - id: echo
    action: echo
    with: { number: '{{issue.number}}', label: 'issue #{{issue.number}}', note: '{{note}}' }
    when: [{ field: issue.number, op: gt, value: 0 }]
  - { function: seen, with: { echoed: '{{steps.echo}}' }, when: [{ field: steps.echo, op: exists }] }
`,
      },
      { actions: { echo: new Echo({ id: 'echo' }) }, functions: { seen } },
    )

    await engine.dispatch(createEvent('a', { issue: { number: 7 } }))
    expect(seen.mock.calls[0]?.[1]).toEqual({ echoed: { number: 7, label: 'issue #7' } })

    await engine.dispatch(createEvent('a', { issue: { number: 0 } }))
    expect(seen).toHaveBeenCalledTimes(1)

    expect(
      await failure(engine.dispatch(createEvent('a', { issue: { number: 1 }, note: 5 }))),
    ).toMatch(/echo: input inválido/)
  })
})

describe('ActionStep', () => {
  it('merges the input it is given (a route, an onError) with its with, which wins', async () => {
    const execute = vi.fn((input: unknown) => input)
    class Take extends Action {
      readonly description = 'toma'
      readonly input = z.strictObject({ reason: z.string(), label: z.string() })
      execute(input: z.infer<typeof this.input>) {
        return execute(input)
      }
    }
    const step = new ActionStep({ action: new Take({ id: 'take' }), with: { label: '{{kind}}' } })
    const ctx = {
      event: createEvent('a', { kind: 'blocked' }),
      steps: {},
      bus: new EventBus(),
      pipelineId: 'p',
    }

    expect(await step.run(ctx, { reason: 'falló', label: 'pisado' })).toEqual({
      reason: 'falló',
      label: 'blocked',
    })
  })
})

describe('emit', () => {
  it('forEach publishes one event per item, with type, payload and scope from the templates', async () => {
    const { engine, emitted } = mount({
      'pipelines/p.yaml': `
id: p
on: [merged]
do:
  - emit: '{{kind}}'
    forEach: '{{dependents}}'
    payload: { number: '{{item.number}}', closed: '{{closed}}' }
    scope: { issue: 'x#{{item.number}}' }
`,
    })

    await engine.dispatch(
      createEvent('merged', {
        kind: 'issue.unblocked',
        closed: 7,
        dependents: [{ number: 9 }, { number: 10 }],
      }),
    )

    expect(
      emitted.filter((e) => e.type === 'issue.unblocked').map((e) => [e.payload, e.scope]),
    ).toEqual([
      [{ number: 9, closed: 7 }, { issue: 'x#9' }],
      [{ number: 10, closed: 7 }, { issue: 'x#10' }],
    ])
  })
})
