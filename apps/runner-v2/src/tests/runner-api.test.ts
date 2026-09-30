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
import type { RunnerStreamEvent } from '@ia-flow/shared'
import assistantActions from '../../.config/actions/assistant.js'
import type { ActionContext } from '../actions/defineAction.js'
import { Assistant } from '../assistant/Assistant.js'
import { AssistantDesk } from '../assistant/AssistantDesk.js'
import { runnerApi } from '../http/runnerApi.js'
import { SseHub } from '../http/sse.js'
import type { ActivityPort } from '../inbox/ActivityPort.js'
import type { BoardCard } from '../inbox/classify.js'
import { InboxSection } from '../inbox/InboxSection.js'
import { InboxService } from '../inbox/InboxService.js'
import { createWebhookServer } from '../server.js'
import { TaskActions } from '../tasks/TaskActions.js'

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

/** GitHub de mentira: el login de un token y lo que se le pidió. */
function fakeGithub(push = true) {
  const calls: Array<{ method: string; url: string; body?: unknown }> = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({
      method: init?.method ?? 'GET',
      url,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    })
    if (url.endsWith('/user')) return Response.json({ login: 'julian' })
    if (url.endsWith('/repos/o/r')) return Response.json({ permissions: { push } })
    return Response.json({ merged: true })
  }) as typeof fetch
  return { calls, fetchImpl }
}

const tool = (ctx: Parameters<Provider['run']>[0], name: string) => {
  const found = ctx.tools.find((candidate) => candidate.name === name)
  if (!found) throw new Error(`el agente no tiene la tool ${name}`)
  return found
}

/** El provider del agente `assistant`: streamea texto, propone una acción con su tool y cierra
 *  con `submit_done`, como pide el contrato de la capacidad. */
const fakeProvider: Provider = {
  id: 'fake',
  run: async (ctx) => {
    ctx.onText?.('Hola. ')
    await tool(ctx, 'assistant_propose_action').handler({
      ref: 'o/r#1',
      action: 'merge',
      reason: 'el reviewer aprobó',
    })
    ctx.onText?.('Te propuse mergear.')
    await tool(ctx, 'submit_done').handler({ result: {} })
    return { outcome: 'success' }
  },
}
const defaultRun = fakeProvider.run

/** La capacidad `assistant` como en el runner: el agente con las actions de
 *  `.config/actions/assistant.ts`, leyendo de la bandeja por el desk. */
function assistantFor(inbox: InboxService): Assistant {
  const desk = new AssistantDesk()
  desk.connect({
    inbox,
    activity,
    config: () => ({ projects: [], pipelines: [], agents: [] }),
    status: () => ({}),
  })
  const [definition] = [assistantActions].flat()
  const actions = definition?.create({ services: { assistant: desk } } as ActionContext) as Action[]
  const agent = new Agent(
    { id: 'assistant', provider: 'fake', prompt: '{{question}}', actions },
    new ProviderRegistry().register(fakeProvider),
  )
  return new Assistant({
    capabilities: new Capabilities({ assistant: agent }, new EventBus()),
    desk,
  })
}

const servers: Array<{ close(): void }> = []
afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})

async function start(token: string | null = TOKEN, push = true) {
  const github = fakeGithub(push)
  const hub = new SseHub<RunnerStreamEvent>()
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
      boards: new Map([['p', { owner: 'o', number: 1 }]]),
      settings,
      redispatch: async () => 'ok',
      stop: () => 'ok',
      changed: (ref) => hub.publish({ type: 'inbox', refs: [ref] }),
      fetchImpl: github.fetchImpl,
    }),
    assistant: assistantFor(inbox),
    config: () => ({ projects: [], pipelines: [], agents: [] }),
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

  it('streams the assistant: text, the proposal, and the end', async () => {
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
    expect(events.map((event) => event.type)).toEqual(['text', 'proposal', 'text', 'done'])
    expect(events[1].proposal).toMatchObject({
      ref: 'o/r#1',
      action: 'merge',
      label: 'Mergear el PR',
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
      await tool(ctx, 'submit_done').handler({ result: {} })
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

  it('without github.clientId there is no device flow', async () => {
    const { call } = await start()
    expect((await call('/api/auth/github/device', { method: 'POST' })).status).toBe(501)
  })
})
