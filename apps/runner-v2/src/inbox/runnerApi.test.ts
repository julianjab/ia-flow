import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, it } from 'bun:test'
import type { AddressInfo } from 'node:net'
import {
  type Action,
  Agent,
  Capabilities,
  EventBus,
  type Provider,
  ProviderRegistry,
} from '@ia-flow/agent-engine'
import type { GithubClient } from '@ia-flow/github-api'
import type { RunnerStreamEvent } from '@ia-flow/shared'
import assistantActions from '../actions/builtin/assistant.js'
import type { ActionContext } from '../actions/defineAction.js'
import { Assistant } from '../assistant/Assistant.js'
import { AssistantDesk } from '../assistant/AssistantDesk.js'
import { createBoards } from '../board/createBoards.js'
import type { ProjectConfig } from '../config/RunnerConfig.js'
import { type DeviceFlow, RefreshRejectedError } from '../github/deviceFlow.js'
import { createWebhookServer } from '../http/server.js'
import { SseHub } from '../http/sse.js'
import { SqliteConversationStore } from '../storage/SqliteConversationStore.js'
import type { ActivityPort } from './ActivityPort.js'
import type { BoardCard } from './classify.js'
import { InboxSection } from './InboxSection.js'
import { InboxService } from './InboxService.js'
import { IngressService } from './IngressService.js'
import { runnerApi } from './runnerApi.js'
import { TaskActions } from './TaskActions.js'

const TOKEN = 'runner-secret'
const settings = InboxSection.parse({})

const cards: BoardCard[] = [
  {
    ref: 'o/r#1',
    projectId: 'p',
    title: 'Mergeable',
    url: 'https://github.com/o/r/issues/1',
    status: 'Review',
    labels: ['reviewed'],
    updatedAt: '2026-09-29T11:00:00Z',
    blockedBy: [],
    pr: { number: 9, url: 'https://github.com/o/r/pull/9' },
  },
]

const activity: ActivityPort = {
  executions: () => [],
  lastEventAt: () => undefined,
  eventsForTask: () => [],
  recentEvents: () => [],
  trace: () => [],
  lastDispatchedEvent: () => undefined,
}

/** El login del token: `gho_revoked` ya no sirve y `gho_other` es otra cuenta. */
function userOf(init?: RequestInit): Response {
  const auth = new Headers(init?.headers).get('authorization')
  if (auth === 'Bearer gho_revoked') return new Response('Bad credentials', { status: 401 })
  return Response.json({ login: auth === 'Bearer gho_other' ? 'otra' : 'julian' })
}

/** Abrir un issue: sólo en julianjab/ia-flow; cualquier otro repo no existe para esa cuenta. */
function openIssue(url: string): Response {
  if (!url.endsWith('/repos/julianjab/ia-flow/issues')) {
    return Response.json({ message: 'Not Found' }, { status: 404 })
  }
  return Response.json(
    { number: 77, html_url: 'https://github.com/julianjab/ia-flow/issues/77' },
    { status: 201 },
  )
}

/** GitHub de mentira: el login de un token y lo que se le pidió. */
function fakeGithub(push = true, mergeableState = 'clean') {
  const calls: Array<{ method: string; url: string; body?: unknown }> = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({
      method: init?.method ?? 'GET',
      url,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    })
    if (url.endsWith('/user')) return userOf(init)
    if (url.endsWith('/repos/o/r')) return Response.json({ permissions: { push } })
    if (url.endsWith('/issues') && init?.method === 'POST') return openIssue(url)
    if (url.endsWith('/pulls/9')) return Response.json({ mergeable_state: mergeableState })
    return Response.json({ merged: true })
  }) as typeof fetch
  return { calls, fetchImpl }
}

const tool = (ctx: Parameters<Provider['run']>[0], name: string) => {
  const found = ctx.tools.find((candidate) => candidate.name === name)
  if (!found) throw new Error(`el agente no tiene la tool ${name}`)
  return found
}

/** El provider del agente `assistant`: narra (no se muestra), propone una acción con su tool y
 *  cierra con la respuesta en `submit_done`, como pide el contrato de la capacidad. */
const fakeProvider: Provider = {
  id: 'fake',
  run: async (ctx) => {
    ctx.onText?.('Voy a mirar la tarea. ')
    await tool(ctx, 'assistant_propose_action').handler({
      ref: 'o/r#1',
      action: 'merge',
      reason: 'el reviewer aprobó',
    })
    await tool(ctx, 'submit_done').handler({
      result: { answer: 'Te propuse mergear.', tasks: ['o/r#1', 'o/r#2'] },
    })
    return { outcome: 'success' }
  },
}
const defaultRun = fakeProvider.run

/** El provider del agente `runner-improvements`: propone un issue (el repo lo fija la config). */
const improverProvider: Provider = {
  id: 'fake-improver',
  run: async (ctx) => {
    await tool(ctx, 'assistant_propose_issue').handler({
      title: 'Cortar el loop del reviewer',
      body: '## Problema\nSe re-dispara.',
      labels: ['runner'],
      reason: 'falló tres veces igual',
    })
    await tool(ctx, 'submit_done').handler({ result: { answer: 'Te propuse un issue.' } })
    return { outcome: 'success' }
  },
}

/** La capacidad `assistant` como en el runner: el agente con las actions de
 *  `src/actions/builtin/assistant.ts`, leyendo de la bandeja por el desk. */
function assistantFor(inbox: InboxService, conversations: SqliteConversationStore): Assistant {
  const desk = new AssistantDesk()
  desk.connect({
    inbox,
    activity,
    config: () => ({ projects: [], pipelines: [], agents: [], providers: [], mcp: [] }),
    status: () => ({}),
  })
  const [definition, proposeIssue] = [assistantActions].flat()
  if (!definition || !proposeIssue) throw new Error('faltan las actions del asistente')
  const ctx = { services: { assistant: desk } } as ActionContext
  const actions = definition.create(ctx) as Action[]
  const providers = new ProviderRegistry().register(fakeProvider).register(improverProvider)
  const agent = new Agent(
    { id: 'assistant', provider: 'fake', prompt: '{{question}}', actions },
    providers,
  )
  const improver = new Agent(
    {
      id: 'runner-improvements',
      provider: 'fake-improver',
      prompt: '{{question}}',
      actions: [
        ...actions,
        (proposeIssue.create(ctx) as Action).bind({ repo: 'julianjab/ia-flow' }),
      ],
    },
    providers,
  )
  return new Assistant({
    capabilities: new Capabilities(
      { assistant: agent, 'assistant.runner-improvements': improver },
      new EventBus(),
    ),
    desk,
    conversations,
    agents: () => [
      { id: 'assistant', label: 'Operación' },
      { id: 'assistant.runner-improvements', label: 'Mejoras del runner' },
      // Declarado sin quién lo cumpla: no se ofrece.
      { id: 'assistant.ghost', label: 'Fantasma' },
    ],
  })
}

const servers: Array<{ close(): void }> = []
afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})

async function start(
  token: string | null = TOKEN,
  push = true,
  mergeableState = 'clean',
  deviceFlow?: DeviceFlow,
) {
  const github = fakeGithub(push, mergeableState)
  const hub = new SseHub<RunnerStreamEvent>()
  const conversations = new SqliteConversationStore(new Database(':memory:'))
  const inbox = new InboxService({
    projects: [{ projectId: 'p', board: { owner: 'o', number: 1 } }],
    board: { cards: async () => cards },
    activity,
    waitingKeys: () => [],
    explain: async () => [],
    settings,
  })
  const api = runnerApi({
    token: token ?? undefined,
    version: 'test',
    projects: [{ id: 'p', board: { owner: 'o', number: 1 } }],
    inbox,
    actions: new TaskActions({
      inbox,
      boards: createBoards(
        [{ id: 'p', board: { owner: 'o', number: 1 } } as ProjectConfig],
        {} as GithubClient,
      ),
      settings,
      redispatch: async () => 'ok',
      rerunReview: async (ref) => `review de ${ref}`,
      stop: () => 'ok',
      resumeStage: () => undefined,
      taskActions: () => ({}),
      instantiate: () => {
        throw new Error('sin actions')
      },
      changed: (ref) => hub.publish({ type: 'inbox', refs: [ref] }),
      fetchImpl: github.fetchImpl,
    }),
    assistant: assistantFor(inbox, conversations),
    conversations,
    ...(deviceFlow ? { deviceFlow } : {}),
    ingress: new IngressService({
      log: { ingressEvents: () => [], ingressCount: () => ({ count: 0 }) },
      retentionDays: 14,
      sources: [{ id: 'github', name: 'GitHub', kind: 'webhook', configured: true }],
    }),
    config: () => ({ projects: [], pipelines: [], agents: [], providers: [], mcp: [] }),
    hub,
    log: () => {},
    fetchImpl: github.fetchImpl,
  })
  const server = createWebhookServer({
    secret: 's',
    onDelivery: async () => {},
    api,
    log: () => {},
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  // Cortar también las conexiones abiertas (keep-alive, el SSE): si no, `fetch` reusa una contra
  // este server cuando el puerto le toca a otro test.
  servers.push({
    close: () => {
      server.closeAllConnections()
      server.close()
    },
  })
  const base = `http://localhost:${(server.address() as AddressInfo).port}`
  const call = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
    fetch(`${base}${path}`, { ...init, headers: { 'x-ia-flow-token': TOKEN, ...init.headers } })
  return { base, call, github, hub }
}

describe('runner API', () => {
  it('fails closed without IA_FLOW_API_TOKEN and rejects a wrong token', async () => {
    const closed = await start(null)
    expect((await closed.call('/api/inbox')).status).toBe(503)
    const open = await start()
    expect((await open.call('/api/inbox', { headers: { 'x-ia-flow-token': 'nope' } })).status).toBe(
      401,
    )
    expect((await open.call('/api/inbox')).status).toBe(200)
    expect((await fetch(`${open.base}/api/inbox?token=${TOKEN}`)).status).toBe(200)
  })

  it('answers CORS preflights for a web on another origin', async () => {
    const { base } = await start()
    const res = await fetch(`${base}/api/inbox`, {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'GET' },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
    expect(res.headers.get('access-control-allow-headers')).toContain('x-github-token')
  })

  it('serves the inbox, the runner info and a task detail', async () => {
    const { call } = await start()
    const inbox = await (await call('/api/inbox')).json()
    expect(inbox.items[0]).toMatchObject({ ref: 'o/r#1', kind: 'merge', actions: ['merge'] })
    const info = await (await call('/api/runner')).json()
    expect(info).toMatchObject({
      service: 'ia-flow-runner',
      github_login: { device_flow: false },
      assistant: true,
      assistant_agents: [
        { id: 'assistant', label: 'Operación' },
        { id: 'assistant.runner-improvements', label: 'Mejoras del runner' },
      ],
    })
    expect((await call('/api/tasks/o/r/1')).status).toBe(200)
    expect((await call('/api/tasks/o/r/404')).status).toBe(404)
  })

  it('an action needs the GitHub login, applies only if it fits, and is signed by that user', async () => {
    const { call, github } = await start()
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      call('/api/tasks/o/r/1/actions', { method: 'POST', body: JSON.stringify(body), headers })

    expect((await post({ action: 'merge' })).status).toBe(401)
    const rejected = await post({ action: 'approve_prd' }, { 'x-github-token': 'gho_x' })
    expect(rejected.status).toBe(409)
    expect(await rejected.json()).toMatchObject({
      ok: false,
      message: expect.stringContaining('no aplica'),
    })

    const merged = await post({ action: 'merge' }, { 'x-github-token': 'gho_x' })
    expect(await merged.json()).toMatchObject({ ok: true, github_login: 'julian' })
    expect(github.calls.find((request) => request.method === 'PUT')).toEqual({
      method: 'PUT',
      url: 'https://api.github.com/repos/o/r/pulls/9/merge',
      body: { merge_method: 'squash' },
    })
  })

  it.each(['blocked', 'dirty', 'behind', 'draft', 'unknown'])(
    'refuses to merge a PR GitHub reports as %s, without calling the merge endpoint',
    async (state) => {
      const { call, github } = await start(TOKEN, true, state)
      const res = await call('/api/tasks/o/r/1/actions', {
        method: 'POST',
        body: JSON.stringify({ action: 'merge' }),
        headers: { 'x-github-token': 'gho_x' },
      })
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({
        ok: false,
        message: expect.stringContaining('no se puede mergear'),
      })
      expect(github.calls.some((request) => request.method === 'PUT')).toBe(false)
    },
  )

  it('merges a PR whose only failing checks are not required (unstable)', async () => {
    const { call, github } = await start(TOKEN, true, 'unstable')
    const res = await call('/api/tasks/o/r/1/actions', {
      method: 'POST',
      body: JSON.stringify({ action: 'merge' }),
      headers: { 'x-github-token': 'gho_x' },
    })
    expect(res.status).toBe(200)
    expect(github.calls.some((request) => request.method === 'PUT')).toBe(true)
  })

  it('refuses an action from someone who cannot write to the repo', async () => {
    const { call, github } = await start(TOKEN, false)
    const res = await call('/api/tasks/o/r/1/actions', {
      method: 'POST',
      body: JSON.stringify({ action: 'merge' }),
      headers: { 'x-github-token': 'gho_x' },
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({
      ok: false,
      message: expect.stringContaining('julian'),
    })
    expect(github.calls.some((request) => request.method === 'PUT')).toBe(false)
  })

  it('streams the assistant: the proposal, then the answer from submit_done', async () => {
    const { call } = await start()
    const res = await call('/api/assistant', {
      method: 'POST',
      body: JSON.stringify({
        scope: { kind: 'task', ref: 'o/r#1' },
        messages: [{ role: 'user', content: '¿qué hago?' }],
      }),
    })
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    const events = (await res.text())
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)))
    // o/r#1 ya tiene su propuesta y o/r#2 queda fuera del contexto: ninguna sale como card.
    expect(events.map((event) => event.type)).toEqual(['proposal', 'text', 'done'])
    expect(events.at(-1)).toEqual({ type: 'done', text: 'Te propuse mergear.' })
    expect(events[0].proposal).toMatchObject({
      ref: 'o/r#1',
      action: 'merge',
      label: 'Mergear el PR',
    })
  })

  it('another agent of the assistant answers when the request names it', async () => {
    const { call } = await start()
    const ask = async (agent: string) =>
      (
        await (
          await call('/api/assistant', {
            method: 'POST',
            body: JSON.stringify({
              scope: { kind: 'general' },
              messages: [{ role: 'user', content: '¿qué falló en el proceso?' }],
              agent,
            }),
          })
        ).text()
      )
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => JSON.parse(line.slice(6)))

    const events = await ask('assistant.runner-improvements')
    expect(events.map((event) => event.type)).toEqual(['proposal', 'text', 'done'])
    // El repo es el que fija la config, no uno que elija el modelo.
    expect(events[0].proposal).toMatchObject({
      kind: 'issue',
      repo: 'julianjab/ia-flow',
      title: 'Cortar el loop del reviewer',
      labels: ['runner'],
      label: 'Abrir un issue en julianjab/ia-flow',
    })
    expect(await ask('assistant.ghost')).toEqual([
      { type: 'error', message: expect.stringContaining('assistant.ghost') },
    ])
  })

  it('opens a proposed issue with the GitHub login of whoever confirms it', async () => {
    const { call, github } = await start()
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      call('/api/issues', { method: 'POST', body: JSON.stringify(body), headers })
    const issue = { repo: 'julianjab/ia-flow', title: 'Cortar el loop', body: 'b', labels: ['x'] }

    expect((await post(issue)).status).toBe(401)
    expect(
      (await post({ ...issue, repo: 'no-es-un-repo' }, { 'x-github-token': 'gho_x' })).status,
    ).toBe(400)

    const created = await post(issue, { 'x-github-token': 'gho_x' })
    expect(await created.json()).toEqual({
      ok: true,
      message: 'julianjab/ia-flow#77 abierto',
      url: 'https://github.com/julianjab/ia-flow/issues/77',
      number: 77,
      github_login: 'julian',
    })
    expect(github.calls.find((request) => request.method === 'POST')).toEqual({
      method: 'POST',
      url: 'https://api.github.com/repos/julianjab/ia-flow/issues',
      body: { title: 'Cortar el loop', body: 'b', labels: ['x'] },
    })

    const refused = await post({ ...issue, repo: 'otra/cosa' }, { 'x-github-token': 'gho_x' })
    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({
      ok: false,
      message: expect.stringContaining('otra/cosa'),
    })
  })

  it('the assistant cannot act outside its task', async () => {
    const { call } = await start()
    let refused = ''
    fakeProvider.run = async (ctx) => {
      await Promise.resolve()
        .then(() =>
          tool(ctx, 'assistant_propose_action').handler({
            ref: 'o/r#2',
            action: 'merge',
            reason: 'x',
          }),
        )
        .catch((err: Error) => {
          refused = err.message
        })
      await tool(ctx, 'submit_done').handler({ result: { answer: 'No puedo: es otra tarea.' } })
      return { outcome: 'success' }
    }
    const res = await call('/api/assistant', {
      method: 'POST',
      body: JSON.stringify({
        scope: { kind: 'task', ref: 'o/r#1' },
        messages: [{ role: 'user', content: 'x' }],
      }),
    })
    expect(await res.text()).toContain('"type":"done"')
    expect(refused).toMatch(/Fuera de contexto/)
    fakeProvider.run = defaultRun
  })

  it('the tasks of an answer come resolved and in scope', async () => {
    const { call } = await start()
    fakeProvider.run = async (ctx) => {
      await tool(ctx, 'submit_done').handler({
        result: { answer: 'Mirá esta.', tasks: ['o/r#1', 'o/r#2'] },
      })
      return { outcome: 'success' }
    }
    const res = await call('/api/assistant', {
      method: 'POST',
      body: JSON.stringify({
        scope: { kind: 'task', ref: 'o/r#1' },
        messages: [{ role: 'user', content: 'x' }],
      }),
    })
    const tasks = (await res.text())
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)))
      .find((event) => event.type === 'tasks')
    // o/r#2 queda fuera del contexto de la tarea: no sale como card.
    expect(tasks.items.map((item: { ref: string }) => item.ref)).toEqual(['o/r#1'])
    fakeProvider.run = defaultRun
  })

  it('a submit_done without an answer is refused, so the model has to answer', async () => {
    const { call } = await start()
    let refused = ''
    fakeProvider.run = async (ctx) => {
      await Promise.resolve()
        .then(() => tool(ctx, 'submit_done').handler({ result: {} }))
        .catch((err: Error) => {
          refused = err.message
        })
      await tool(ctx, 'submit_done').handler({ result: { answer: 'Nada raro.' } })
      return { outcome: 'success' }
    }
    const res = await call('/api/assistant', {
      method: 'POST',
      body: JSON.stringify({
        scope: { kind: 'task', ref: 'o/r#1' },
        messages: [{ role: 'user', content: 'x' }],
      }),
    })
    expect(await res.text()).toContain('"text":"Nada raro."')
    expect(refused).toMatch(/answer/)
    fakeProvider.run = defaultRun
  })

  describe('saved conversations', () => {
    const ask = (
      call: Awaited<ReturnType<typeof start>>['call'],
      body: Record<string, unknown>,
      headers: Record<string, string> = {},
    ) =>
      call('/api/assistant', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          scope: { kind: 'task', ref: 'o/r#1' },
          messages: [{ role: 'user', content: '¿qué hago?' }],
          ...body,
        }),
      })
    const events = async (res: Response) =>
      (await res.text())
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => JSON.parse(line.slice(6)))
    const gh = (token = 'gho_x') => ({ 'x-github-token': token })

    it('without a GitHub login nothing is saved', async () => {
      const { call } = await start()
      const types = (await events(await ask(call, {}))).map((event) => event.type)
      expect(types).not.toContain('conversation')
      expect((await call('/api/assistant/conversations')).status).toBe(401)
    })

    it('with a login, each exchange lands in one conversation of that context', async () => {
      const { call } = await start()
      const first = await events(await ask(call, {}, gh()))
      const id = first.find((event) => event.type === 'conversation')?.id
      expect(id).toBeString()
      // La segunda respuesta nombra la tarea sin proponer nada: esa sí va como card.
      fakeProvider.run = async (ctx) => {
        await tool(ctx, 'submit_done').handler({ result: { answer: 'Es ésta.', tasks: ['o/r#1'] } })
        return { outcome: 'success' }
      }
      await events(await ask(call, { conversation_id: id }, gh()))
      fakeProvider.run = defaultRun

      const scope = encodeURIComponent(JSON.stringify({ kind: 'task', ref: 'o/r#1' }))
      const list = await (
        await call(`/api/assistant/conversations?scope=${scope}`, { headers: gh() })
      ).json()
      expect(list).toMatchObject([{ id, title: '¿qué hago?', messages: 4 }])
      const other = encodeURIComponent(JSON.stringify({ kind: 'general' }))
      expect(
        await (await call(`/api/assistant/conversations?scope=${other}`, { headers: gh() })).json(),
      ).toEqual([])

      const saved = await (
        await call(`/api/assistant/conversations/${id}`, { headers: gh() })
      ).json()
      expect(saved.thread.map((m: { role: string }) => m.role)).toEqual([
        'user',
        'assistant',
        'user',
        'assistant',
      ])
      // La propuesta, como se hizo (su tarea no se repite como card); las tareas, como están
      // ahora en la bandeja.
      expect(saved.thread[1]).toMatchObject({
        content: 'Te propuse mergear.',
        tasks: [],
        proposals: [{ action: 'merge', ref: 'o/r#1' }],
      })
      expect(saved.thread[3]).toMatchObject({
        content: 'Es ésta.',
        tasks: [{ ref: 'o/r#1', kind: 'merge' }],
        proposals: [],
      })
    })

    it('a GitHub token that no longer works still gets an answer, just not saved', async () => {
      const { call } = await start()
      const types = (await events(await ask(call, {}, gh('gho_revoked')))).map((e) => e.type)
      expect(types).toContain('done')
      expect(types).not.toContain('conversation')
    })

    it('a conversation that is gone continues in a new one instead of failing', async () => {
      const { call } = await start()
      const id = (await events(await ask(call, {}, gh()))).find(
        (e) => e.type === 'conversation',
      )?.id
      await call(`/api/assistant/conversations/${id}`, { method: 'DELETE', headers: gh() })
      const next = (await events(await ask(call, { conversation_id: id }, gh()))).find(
        (e) => e.type === 'conversation',
      )?.id
      expect(next).toBeString()
      expect(next).not.toBe(id)
    })

    it('a conversation is of one agent: asking another one continues in a new one', async () => {
      const { call } = await start()
      const first = await events(await ask(call, {}, gh()))
      const id = first.find((event) => event.type === 'conversation')?.id
      const other = await events(
        await ask(call, { conversation_id: id, agent: 'assistant.runner-improvements' }, gh()),
      )
      const next = other.find((event) => event.type === 'conversation')?.id
      expect(next).toBeString()
      expect(next).not.toBe(id)
      const list = await (await call('/api/assistant/conversations', { headers: gh() })).json()
      expect(list.map((c: { id: string; agent: string }) => [c.id, c.agent]).sort()).toEqual(
        [
          [id, 'assistant'],
          [next, 'assistant.runner-improvements'],
        ].sort(),
      )
      // La propuesta de issue se guarda tal cual, para mostrarla al retomar.
      const saved = await (
        await call(`/api/assistant/conversations/${next}`, { headers: gh() })
      ).json()
      expect(saved.thread[1].proposals).toMatchObject([
        { kind: 'issue', repo: 'julianjab/ia-flow' },
      ])
    })

    it("someone else's conversation does not exist for you", async () => {
      const { call } = await start()
      const id = (await events(await ask(call, {}, gh()))).find(
        (e) => e.type === 'conversation',
      )?.id
      expect(
        (await call(`/api/assistant/conversations/${id}`, { headers: gh('gho_other') })).status,
      ).toBe(404)
      // Seguirla con otro login abre una nueva de ese login: la ajena no crece ni se lee.
      const other = (await events(await ask(call, { conversation_id: id }, gh('gho_other')))).find(
        (e) => e.type === 'conversation',
      )?.id
      expect(other).toBeString()
      expect(other).not.toBe(id)
      expect(
        (await (await call(`/api/assistant/conversations/${id}`, { headers: gh() })).json())
          .messages,
      ).toBe(2)
      expect(
        (
          await call(`/api/assistant/conversations/${id}`, {
            method: 'DELETE',
            headers: gh('gho_other'),
          })
        ).status,
      ).toBe(404)
      expect(
        (await call(`/api/assistant/conversations/${id}`, { method: 'DELETE', headers: gh() }))
          .status,
      ).toBe(200)
      expect((await call(`/api/assistant/conversations/${id}`, { headers: gh() })).status).toBe(404)
    })
  })

  it('the stream tells the web what changed', async () => {
    const { base, hub } = await start()
    const res = await fetch(`${base}/api/stream?token=${TOKEN}`)
    const reader = res.body?.getReader() as ReadableStreamDefaultReader<Uint8Array>
    await reader.read()
    hub.publish({ type: 'inbox', refs: ['o/r#1'] })
    const { value } = await reader.read()
    expect(new TextDecoder().decode(value)).toContain('"refs":["o/r#1"]')
    await reader.cancel()
  })

  it('serves the ingresses and what arrived at each; an unknown one is a 404', async () => {
    const { call } = await start()
    const ingress = await (await call('/api/ingress')).json()
    expect(ingress).toMatchObject({ sources: [{ id: 'github', count_24h: 0 }], retention_days: 14 })
    expect(await (await call('/api/ingress/github/events')).json()).toEqual([])
    expect((await call('/api/ingress/jira/events')).status).toBe(404)
  })

  it('without github.clientId there is no device flow', async () => {
    const { call } = await start()
    expect((await call('/api/auth/github/device', { method: 'POST' })).status).toBe(501)
    const refresh = { method: 'POST', body: JSON.stringify({ refresh_token: 'ghr_x' }) }
    expect((await call('/api/auth/github/refresh', refresh)).status).toBe(501)
  })

  it('refresh renews the token, and a refresh token GitHub rejects is a 401', async () => {
    const renewing = { refresh: async () => ({ access_token: 'ghu_new', login: 'julian' }) }
    const rejecting = {
      refresh: async () => {
        throw new RefreshRejectedError('GitHub no renovó el token: expired')
      },
    }
    const refresh = { method: 'POST', body: JSON.stringify({ refresh_token: 'ghr_x' }) }

    const ok = await (await start(TOKEN, true, 'clean', renewing as never)).call(
      '/api/auth/github/refresh',
      refresh,
    )
    expect(await ok.json()).toEqual({ access_token: 'ghu_new', login: 'julian' })

    const no = await (await start(TOKEN, true, 'clean', rejecting as never)).call(
      '/api/auth/github/refresh',
      refresh,
    )
    expect(no.status).toBe(401)
    expect(await no.json()).toEqual({ error: 'GitHub no renovó el token: expired' })
  })
})
