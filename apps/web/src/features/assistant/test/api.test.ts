import type { AssistantStreamEvent } from '@ia-flow/shared'
import axios from 'axios'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/composables/useServerTarget', () => ({
  serverTarget: () => ({ base: 'http://r:1', token: 'ia', url: (p: string) => `http://r:1${p}` }),
}))

import {
  addToBoard,
  changeLabels,
  createIssue,
  executeProposal,
  fetchRunner,
  fetchTasks,
  moveTask,
  streamAssistant,
} from '../api'

const REQUEST = {
  scope: { kind: 'general' as const },
  messages: [{ role: 'user' as const, content: 'hola' }],
}

/** Una Response cuyo body entrega los chunks dados, como un SSE real. */
function sseResponse(chunks: string[], init: ResponseInit = { status: 200 }): Response {
  const enc = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c))
      controller.close()
    },
  })
  return new Response(body, { headers: { 'content-type': 'text/event-stream' }, ...init })
}

async function collect(gen: AsyncGenerator<AssistantStreamEvent>): Promise<AssistantStreamEvent[]> {
  const out: AssistantStreamEvent[] = []
  for await (const e of gen) out.push(e)
  return out
}

const data = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`

describe('streamAssistant', () => {
  it('POSTea la conversación con el token de ia-flow y entrega los eventos en orden', async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse([
        data({ type: 'tool', name: 'get_task', summary: 'leyendo a/b#1' }),
        data({ type: 'text', delta: 'Hola' }),
        data({ type: 'text', delta: ' mundo' }),
        data({ type: 'done', text: 'Hola mundo' }),
      ]),
    )
    const events = await collect(
      streamAssistant(REQUEST, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    )

    expect(events.map((e) => e.type)).toEqual(['tool', 'text', 'text', 'done'])
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://r:1/api/assistant')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['x-ia-flow-token']).toBe('ia')
    expect(JSON.parse(init.body as string)).toEqual(REQUEST)
  })

  it('reensambla un evento partido entre dos chunks', async () => {
    const whole = data({ type: 'text', delta: 'partido' })
    const fetchImpl = async () =>
      sseResponse([whole.slice(0, 12), whole.slice(12), data({ type: 'done', text: 'partido' })])
    const events = await collect(
      streamAssistant(REQUEST, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    )
    expect(events[0]).toEqual({ type: 'text', delta: 'partido' })
  })

  it('un HTTP de error sale como un evento error con el mensaje del runner', async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: 'asistente apagado' }), { status: 503 })
    expect(
      await collect(streamAssistant(REQUEST, { fetchImpl: fetchImpl as unknown as typeof fetch })),
    ).toEqual([{ type: 'error', message: 'asistente apagado' }])
  })

  it('un stream que se corta sin done avisa; uno que trae error no repite el aviso', async () => {
    const cut = async () => sseResponse([data({ type: 'text', delta: 'a medias' })])
    const events = await collect(
      streamAssistant(REQUEST, { fetchImpl: cut as unknown as typeof fetch }),
    )
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      message: expect.stringContaining('Se cortó'),
    })

    const withError = async () => sseResponse([data({ type: 'error', message: 'provider caído' })])
    expect(
      await collect(streamAssistant(REQUEST, { fetchImpl: withError as unknown as typeof fetch })),
    ).toEqual([{ type: 'error', message: 'provider caído' }])
  })

  it('un fallo de red es un evento error; abortar (Stop) no emite nada', async () => {
    const down = async () => {
      throw new Error('fetch failed')
    }
    expect(
      await collect(streamAssistant(REQUEST, { fetchImpl: down as unknown as typeof fetch })),
    ).toEqual([{ type: 'error', message: 'fetch failed' }])

    const ctl = new AbortController()
    ctl.abort()
    const aborted = async () => {
      throw new DOMException('aborted', 'AbortError')
    }
    expect(
      await collect(
        streamAssistant(REQUEST, {
          fetchImpl: aborted as unknown as typeof fetch,
          signal: ctl.signal,
        }),
      ),
    ).toEqual([])
  })

  it('ignora eventos que no cumplen el contrato', async () => {
    const fetchImpl = async () =>
      sseResponse(['data: basura\n\n', data({ type: 'nuevo' }), data({ type: 'done', text: 'ok' })])
    const events = await collect(
      streamAssistant(REQUEST, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    )
    expect(events).toEqual([{ type: 'done', text: 'ok' }])
  })
})

describe('executeProposal / createIssue / fetchRunner', () => {
  afterEach(() => vi.restoreAllMocks())

  it('ejecuta con el token de GitHub del usuario contra el endpoint de acciones', async () => {
    const post = vi
      .spyOn(axios, 'post')
      .mockResolvedValue({ status: 200, data: { ok: true, message: 'Hecho' } })
    const result = await executeProposal(
      { ref: 'acme/api#7', action: 'answer_and_unblock', comment: 'Son 90 días' },
      'gho_1',
    )
    expect(result.ok).toBe(true)
    const [url, body, config] = post.mock.calls[0] as unknown as [
      string,
      unknown,
      { headers: Record<string, string> },
    ]
    expect(url).toBe('/api/tasks/acme/api/7/actions')
    expect(body).toEqual({ action: 'answer_and_unblock', comment: 'Son 90 días' })
    expect(config.headers['x-github-token']).toBe('gho_1')
  })

  it('una ref inválida falla antes de la red', async () => {
    const post = vi.spyOn(axios, 'post')
    await expect(executeProposal({ ref: 'mal', action: 'merge' }, 't')).rejects.toThrow(/inválida/)
    expect(post).not.toHaveBeenCalled()
  })

  it('abre un issue propuesto con el token de GitHub del usuario', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValue({
      status: 200,
      data: { ok: true, message: 'o/r#3 abierto', url: 'https://github.com/o/r/issues/3' },
    })
    const result = await createIssue({ repo: 'o/r', title: 'T', body: 'B', labels: ['x'] }, 'gho_1')
    expect(result).toMatchObject({ ok: true, url: 'https://github.com/o/r/issues/3' })
    const [url, body, config] = post.mock.calls[0] as unknown as [
      string,
      unknown,
      { headers: Record<string, string> },
    ]
    expect(url).toBe('/api/issues')
    expect(body).toEqual({ repo: 'o/r', title: 'T', body: 'B', labels: ['x'] })
    expect(config.headers['x-github-token']).toBe('gho_1')
  })

  it('con board, el issue se pide abierto y sumado a ese proyecto en la columna elegida', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValue({
      status: 200,
      data: {
        ok: true,
        message: 'o/r#4 abierto',
        url: 'https://github.com/o/r/issues/4',
        board_error: 'el Project no acepta el repo',
      },
    })
    const result = await createIssue(
      { repo: 'o/r', title: 'T', body: 'B', board: { project_id: 'core', status: 'Refine' } },
      'gho_1',
    )
    expect(result).toMatchObject({ ok: true, board_error: 'el Project no acepta el repo' })
    expect(post.mock.calls[0]?.[1]).toEqual({
      repo: 'o/r',
      title: 'T',
      body: 'B',
      board: { project_id: 'core', status: 'Refine' },
    })

    // Sin columna: el runner lo deja en Todo.
    await createIssue({ repo: 'o/r', title: 'T', body: 'B', board: { project_id: 'core' } }, 'g')
    expect(post.mock.calls[1]?.[1]).toEqual({
      repo: 'o/r',
      title: 'T',
      body: 'B',
      board: { project_id: 'core' },
    })
  })

  it('fetchTasks trae las tareas y las columnas de cada proyecto de /api/inbox', async () => {
    const get = vi.spyOn(axios, 'get').mockResolvedValue({
      data: {
        generated_at: 'x',
        projects: [
          { id: 'core', board: { owner: 'a', number: 1 }, statuses: ['Todo', 'Refine'] },
          { id: 'old', board: { owner: 'b', number: 2 } },
        ],
        items: [],
      },
    })
    expect(await fetchTasks()).toEqual({ items: [], statuses: { core: ['Todo', 'Refine'] } })
    expect(get).toHaveBeenCalledWith('/api/inbox')
  })

  it('fetchRunner lee los proyectos y los agentes del asistente de /api/runner', async () => {
    const info = {
      service: 'ia-flow-runner',
      version: '2',
      projects: [{ id: 'core', board: { owner: 'a', number: 1 } }],
      github_login: { device_flow: true },
      assistant: true,
    }
    const get = vi.spyOn(axios, 'get').mockResolvedValue({
      data: { ...info, assistant_agents: [{ id: 'assistant', label: 'Operación' }] },
    })
    expect(await fetchRunner()).toEqual({
      projects: [{ id: 'core', board: { owner: 'a', number: 1 } }],
      agents: [{ id: 'assistant', label: 'Operación' }],
    })
    // Un runner de antes de los agentes no los manda: no hay qué elegir.
    get.mockResolvedValue({ data: info })
    expect((await fetchRunner()).agents).toEqual([])
  })
})

describe('propuestas del board', () => {
  afterEach(() => vi.restoreAllMocks())

  const sent = (post: { mock: { calls: unknown[][] } }) => {
    const [url, body, config] = post.mock.calls[0] as unknown as [
      string,
      unknown,
      { headers: Record<string, string> },
    ]
    return { url, body, token: config.headers['x-github-token'] }
  }

  it('mover pega en /status con la columna', async () => {
    const post = vi
      .spyOn(axios, 'post')
      .mockResolvedValue({ status: 200, data: { ok: true, message: 'movida de Build a Refine' } })
    await expect(moveTask({ ref: 'acme/api#7', status: 'Refine' }, 'gho_1')).resolves.toMatchObject(
      {
        ok: true,
      },
    )
    expect(sent(post)).toEqual({
      url: '/api/tasks/acme/api/7/status',
      body: { status: 'Refine' },
      token: 'gho_1',
    })
  })

  it('sumar al board pega en /api/board/items sin mandar lo que no se eligió', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValue({
      status: 200,
      data: { ok: true, message: 'acme/api#9 agregado en Todo' },
    })
    await addToBoard({ issue: 'acme/api#9' }, 'gho_1')
    expect(sent(post)).toEqual({
      url: '/api/board/items',
      body: { issue: 'acme/api#9' },
      token: 'gho_1',
    })
  })

  it('labels pega en /labels; un rechazo vuelve con su mensaje', async () => {
    const post = vi
      .spyOn(axios, 'post')
      .mockResolvedValue({ status: 403, data: { ok: false, message: 'ada no tiene permiso' } })
    await expect(
      changeLabels({ ref: 'acme/api#7', remove: ['blocked'] }, 'gho_1'),
    ).resolves.toEqual({ ok: false, message: 'ada no tiene permiso' })
    expect(sent(post)).toEqual({
      url: '/api/tasks/acme/api/7/labels',
      body: { remove: ['blocked'] },
      token: 'gho_1',
    })
  })
})
