import type { AssistantProposal, AssistantRequest, AssistantStreamEvent } from '@ia-flow/shared'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Script = (req: AssistantRequest, signal?: AbortSignal) => AsyncGenerator<AssistantStreamEvent>
let script: Script = async function* () {}
const requests: AssistantRequest[] = []
const streamOpts: Array<{ githubToken?: string }> = []

const executeProposal = vi.fn()
const createIssue = vi.fn()
const fetchRunner = vi.fn()

vi.mock('../api', () => ({
  streamAssistant: (
    req: AssistantRequest,
    opts: { signal?: AbortSignal; githubToken?: string },
  ) => {
    requests.push(JSON.parse(JSON.stringify(req)))
    streamOpts.push({ ...(opts.githubToken ? { githubToken: opts.githubToken } : {}) })
    return script(req, opts.signal)
  },
  executeProposal: (...a: unknown[]) => executeProposal(...a),
  createIssue: (...a: unknown[]) => createIssue(...a),
  fetchRunner: () => fetchRunner(),
  fetchTasks: async () => [{ ref: 'acme/api#7', title: 'Algo', group: 'need', kind: 'merge' }],
}))

import { useGithubSessionStore } from '@/stores/githubSession'
import { sameScope, useAssistantChatStore } from '../store'

const proposal: AssistantProposal = {
  id: 'p1',
  ref: 'acme/api#7',
  action: 'merge',
  label: 'Mergear el PR',
  reason: 'CI verde',
}

const say = (text: string): Script =>
  async function* () {
    yield { type: 'text', delta: text.slice(0, 3) }
    yield { type: 'text', delta: text.slice(3) }
    yield { type: 'done', text }
  }

describe('useAssistantChatStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    requests.length = 0
    streamOpts.length = 0
    script = say('respuesta')
    executeProposal.mockReset()
    createIssue.mockReset()
    fetchRunner.mockReset().mockResolvedValue({ projects: [], agents: [] })
  })

  it('el texto llega en deltas y queda en un turno del asistente', async () => {
    const chat = useAssistantChatStore()
    await chat.send('  ¿qué pasó?  ')
    expect(chat.turns.map((t) => t.kind)).toEqual(['user', 'assistant'])
    expect(chat.turns[0]).toMatchObject({ text: '¿qué pasó?' })
    expect(chat.turns[1]).toMatchObject({ text: 'respuesta', streaming: false })
    expect(chat.streaming).toBe(false)
  })

  it('las tareas de la respuesta quedan como un turno propio, debajo del texto', async () => {
    const task = {
      ref: 'acme/api#7',
      project_id: 'core',
      title: 'Algo',
      url: 'https://github.com/acme/api/issues/7',
      group: 'need' as const,
      kind: 'merge' as const,
      labels: [],
      why: 'PR aprobado',
      since: '2026-09-30T10:00:00Z',
      actions: ['merge' as const],
    }
    script = async function* () {
      yield { type: 'text', delta: 'Mirá esta.' }
      yield { type: 'tasks', items: [task] }
      yield { type: 'done', text: 'Mirá esta.' }
    }
    const chat = useAssistantChatStore()
    await chat.send('¿qué me necesita?')
    expect(chat.turns.map((t) => t.kind)).toEqual(['user', 'assistant', 'tasks'])
    expect(chat.turns[2]).toMatchObject({ items: [{ ref: 'acme/api#7' }] })
  })

  it('manda el contexto y la conversación completa (el servidor es stateless)', async () => {
    const chat = useAssistantChatStore()
    chat.setScope({ kind: 'task', ref: 'acme/api#7' })
    await chat.send('uno')
    await chat.send('dos')
    expect(requests[0]).toEqual({
      scope: { kind: 'task', ref: 'acme/api#7' },
      messages: [{ role: 'user', content: 'uno' }],
    })
    expect(requests[1]?.messages.map((m) => `${m.role}:${m.content}`)).toEqual([
      'user:uno',
      'assistant:respuesta',
      'user:dos',
    ])
  })

  it('cambiar de contexto aparca la conversación, y volver la trae de vuelta', async () => {
    const chat = useAssistantChatStore()
    chat.setScope({ kind: 'task', ref: 'acme/api#7' })
    await chat.send('¿qué pasó?')
    chat.setScope({ kind: 'general' })
    expect(chat.turns).toEqual([])
    chat.setScope({ kind: 'task', ref: 'acme/api#7' })
    expect(chat.turns.map((t) => t.kind)).toEqual(['user', 'assistant'])
    // Y la historia vuelve con ella: la próxima pregunta la sigue.
    await chat.send('¿y ahora?')
    expect(requests.at(-1)?.messages.map((m) => m.content)).toEqual([
      '¿qué pasó?',
      'respuesta',
      '¿y ahora?',
    ])
  })

  describe('conversaciones guardadas', () => {
    const saved = (text: string): Script =>
      async function* () {
        yield { type: 'text', delta: text }
        yield { type: 'conversation', id: 'c1' }
        yield { type: 'done', text }
      }

    it('con login, la respuesta trae su conversación y la próxima pregunta la sigue', async () => {
      useGithubSessionStore().github = { login: 'julian', token: 'gho_1' }
      script = saved('uno')
      const chat = useAssistantChatStore()
      await chat.send('¿qué pasó?')
      expect(chat.conversationId).toBe('c1')
      await chat.send('¿y ahora?')
      expect(requests[1]?.conversation_id).toBe('c1')
      expect(streamOpts[1]).toEqual({ githubToken: 'gho_1' })
    })

    it('sin login no se manda ni el token ni la conversación', async () => {
      const chat = useAssistantChatStore()
      chat.conversationId = 'c1'
      await chat.send('hola')
      expect(requests[0]?.conversation_id).toBeUndefined()
      expect(streamOpts[0]).toEqual({})
    })

    it('«Nueva» empieza de cero en el mismo contexto: el modelo ya no ve lo anterior', async () => {
      useGithubSessionStore().github = { login: 'julian', token: 'gho_1' }
      script = saved('uno')
      const chat = useAssistantChatStore()
      chat.setScope({ kind: 'task', ref: 'acme/api#7' })
      await chat.send('primera')
      chat.newConversation()
      expect(chat.turns).toEqual([])
      expect(chat.conversationId).toBeNull()
      expect(chat.scope).toEqual({ kind: 'task', ref: 'acme/api#7' })
      await chat.send('segunda')
      expect(requests[1]?.messages).toEqual([{ role: 'user', content: 'segunda' }])
      expect(requests[1]?.conversation_id).toBeUndefined()
    })

    it('retomar una conversación la dibuja y la sigue; sus propuestas ya no se ejecutan desde acá', async () => {
      const chat = useAssistantChatStore()
      chat.resume({
        id: 'c9',
        scope: { kind: 'task', ref: 'acme/api#7' },
        agent: 'assistant',
        title: '¿qué hago?',
        created_at: '2026-09-30T10:00:00Z',
        updated_at: '2026-09-30T10:01:00Z',
        messages: 2,
        thread: [
          { role: 'user', content: '¿qué hago?', created_at: 'x', proposals: [], tasks: [] },
          {
            role: 'assistant',
            content: 'Mergeá.',
            created_at: 'x',
            proposals: [proposal],
            tasks: [],
          },
        ],
      })
      expect(chat.scope).toEqual({ kind: 'task', ref: 'acme/api#7' })
      expect(chat.conversationId).toBe('c9')
      expect(chat.turns.map((t) => t.kind)).toEqual(['user', 'assistant', 'proposal'])
      expect(chat.turns[2]).toMatchObject({ status: 'past' })
      useGithubSessionStore().github = { login: 'julian', token: 'gho_1' }
      await chat.send('¿y después?')
      expect(requests[0]?.messages.map((m) => m.content)).toEqual([
        '¿qué hago?',
        'Mergeá.',
        '¿y después?',
      ])
      expect(requests[0]?.conversation_id).toBe('c9')
    })
  })

  it('una línea de actividad se ve mientras trabaja y se va al terminar', async () => {
    let seen: unknown[] = []
    const chat = useAssistantChatStore()
    script = async function* () {
      yield { type: 'tool', name: 'get_task', summary: 'leyendo acme/api#7' }
      seen = chat.turns.map((t) => (t.kind === 'assistant' ? t.activity : null))
      yield { type: 'text', delta: 'listo' }
      yield { type: 'done', text: 'listo' }
    }
    await chat.send('hola')
    expect(seen).toContain('leyendo acme/api#7')
    expect(chat.turns[1]).toMatchObject({ activity: null })
  })

  it('una propuesta es un turno propio, abierto, y no se ejecuta sola', async () => {
    script = async function* () {
      yield { type: 'text', delta: 'Conviene mergear.' }
      yield { type: 'proposal', proposal }
      yield { type: 'done', text: 'Conviene mergear.' }
    }
    const chat = useAssistantChatStore()
    await chat.send('¿qué hago?')
    expect(chat.turns.map((t) => t.kind)).toEqual(['user', 'assistant', 'proposal'])
    expect(chat.turns[2]).toMatchObject({ status: 'open' })
    expect(executeProposal).not.toHaveBeenCalled()
  })

  it('ejecutar una propuesta la firma con el token del usuario y agrega una nota a la próxima pregunta', async () => {
    script = async function* () {
      yield { type: 'proposal', proposal }
      yield { type: 'done', text: '' }
    }
    executeProposal.mockResolvedValue({ ok: true, message: 'Mergeado' })
    const chat = useAssistantChatStore()
    await chat.send('mergea')
    const id = chat.turns.find((t) => t.kind === 'proposal')?.id as number

    await chat.runProposal(id, 'gho_1')
    expect(executeProposal).toHaveBeenCalledWith(proposal, 'gho_1')
    expect(chat.turns.find((t) => t.id === id)).toMatchObject({
      status: 'done',
      message: 'Mergeado',
    })

    script = say('ok')
    await chat.send('¿y ahora?')
    const last = requests.at(-1)?.messages.at(-1)
    expect(last?.content).toBe(
      '[Nota: el usuario ejecutó "Mergear el PR" sobre acme/api#7]\n¿y ahora?',
    )
  })

  it('descartar deja una nota; un rechazo del runner deja la propuesta abierta con su error', async () => {
    script = async function* () {
      yield { type: 'proposal', proposal }
      yield { type: 'done', text: '' }
    }
    const chat = useAssistantChatStore()
    await chat.send('a')
    const id = chat.turns.find((t) => t.kind === 'proposal')?.id as number

    executeProposal.mockResolvedValue({ ok: false, message: 'Sin permisos' })
    await chat.runProposal(id, 't')
    expect(chat.turns.find((t) => t.id === id)).toMatchObject({
      status: 'open',
      error: 'Sin permisos',
    })

    chat.dismissProposal(id)
    expect(chat.turns.find((t) => t.id === id)).toMatchObject({ status: 'dismissed' })
    script = say('ok')
    await chat.send('b')
    expect(requests.at(-1)?.messages.at(-1)?.content).toContain(
      '[Nota: el usuario descartó "Mergear el PR"',
    )
  })

  it('un error se muestra y la pregunta huérfana no queda en el historial', async () => {
    script = async function* () {
      yield { type: 'error', message: 'provider caído' }
    }
    const chat = useAssistantChatStore()
    await chat.send('hola')
    expect(chat.turns.map((t) => t.kind)).toEqual(['user', 'note'])
    expect(chat.turns[1]).toMatchObject({ text: 'provider caído' })

    script = say('bien')
    await chat.send('otra vez')
    expect(requests.at(-1)?.messages).toEqual([{ role: 'user', content: 'otra vez' }])
  })

  it('Stop corta el stream y conserva lo que ya llegó', async () => {
    const chat = useAssistantChatStore()
    script = async function* (_req, signal) {
      yield { type: 'text', delta: 'parcial' }
      await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve()))
    }
    const pending = chat.send('hola')
    await vi.waitFor(() => expect(chat.turns[1]).toMatchObject({ text: 'parcial' }))
    expect(chat.streaming).toBe(true)
    chat.stop()
    await pending
    expect(chat.streaming).toBe(false)
    expect(chat.turns[1]).toMatchObject({ text: 'parcial', streaming: false })
  })

  it('no manda una pregunta vacía ni una segunda mientras responde', async () => {
    const chat = useAssistantChatStore()
    await chat.send('   ')
    expect(requests).toHaveLength(0)

    let release: () => void = () => {}
    script = async function* () {
      await new Promise<void>((r) => {
        release = r
      })
      yield { type: 'done', text: 'x' }
    }
    const first = chat.send('uno')
    await chat.send('dos')
    expect(requests).toHaveLength(1)
    release()
    await first
  })

  it('cambiar de contexto empieza una conversación nueva; elegir el mismo no', async () => {
    const chat = useAssistantChatStore()
    await chat.send('hola')
    chat.setScope({ kind: 'general' })
    expect(chat.turns).toHaveLength(2)
    chat.setScope({ kind: 'task', ref: 'acme/api#7' })
    expect(chat.turns).toHaveLength(0)
  })

  it('con un solo proyecto arranca en él; con varios, en general — y trae las tareas para el #', async () => {
    fetchRunner.mockResolvedValue({
      projects: [{ id: 'core', board: { owner: 'a', number: 1 } }],
      agents: [],
    })
    const one = useAssistantChatStore()
    await one.loadProjects()
    expect(one.scope).toEqual({ kind: 'project', project_id: 'core' })
    expect(one.tasks.map((t) => t.ref)).toEqual(['acme/api#7'])

    setActivePinia(createPinia())
    fetchRunner.mockResolvedValue({
      projects: [
        { id: 'core', board: { owner: 'a', number: 1 } },
        { id: 'web', board: { owner: 'b', number: 2 } },
      ],
      agents: [],
    })
    const many = useAssistantChatStore()
    await many.loadProjects()
    expect(many.scope).toEqual({ kind: 'general' })
  })

  it('las sugerencias cambian con el contexto', () => {
    const chat = useAssistantChatStore()
    const general = [...chat.suggestions]
    chat.setScope({ kind: 'task', ref: 'a/b#1' })
    expect(chat.suggestions).not.toEqual(general)
    expect(chat.suggestions[0]).toBe('¿Qué pasó con esta tarea?')
  })

  it('con otro agente, la pregunta lo nombra y es otra conversación; volver trae la anterior', async () => {
    fetchRunner.mockResolvedValue({
      projects: [],
      agents: [
        { id: 'assistant', label: 'Operación' },
        { id: 'assistant.runner-improvements', label: 'Mejoras del runner' },
      ],
    })
    const chat = useAssistantChatStore()
    await chat.loadProjects()
    await chat.send('hola')
    expect(requests.at(-1)).not.toHaveProperty('agent')

    chat.setAgent('assistant.runner-improvements')
    expect(chat.turns).toHaveLength(0)
    expect(chat.suggestions[0]).toBe('¿Qué falló en el proceso y cómo se evita?')
    await chat.send('¿qué mejorarías?')
    expect(requests.at(-1)).toMatchObject({ agent: 'assistant.runner-improvements' })

    chat.setAgent('assistant')
    expect(chat.turns.map((t) => (t.kind === 'user' ? t.text : t.kind))).toEqual([
      'hola',
      'assistant',
    ])
  })

  it('un agente que el runner ya no ofrece vuelve al de siempre', async () => {
    const chat = useAssistantChatStore()
    chat.setAgent('assistant.runner-improvements')
    await chat.loadProjects()
    expect(chat.agent).toBe('assistant')
  })

  it('una propuesta de issue lo abre con el token del usuario y la nota lleva su link', async () => {
    const issue: AssistantProposal = {
      id: 'i1',
      kind: 'issue',
      repo: 'julianjab/ia-flow',
      title: 'Cortar el loop',
      body: 'cuerpo',
      label: 'Abrir un issue en julianjab/ia-flow',
      reason: 'se repite',
    }
    script = async function* () {
      yield { type: 'proposal', proposal: issue }
      yield { type: 'done', text: 'Te propuse un issue.' }
    }
    createIssue.mockResolvedValue({
      ok: true,
      message: 'julianjab/ia-flow#77 abierto',
      url: 'https://github.com/julianjab/ia-flow/issues/77',
    })
    const chat = useAssistantChatStore()
    await chat.send('¿qué mejorarías?')
    const id = chat.turns.find((t) => t.kind === 'proposal')?.id as number

    await chat.runProposal(id, 'gho_1')
    expect(createIssue).toHaveBeenCalledWith(issue, 'gho_1')
    expect(executeProposal).not.toHaveBeenCalled()
    expect(chat.turns.find((t) => t.id === id)).toMatchObject({
      status: 'done',
      url: 'https://github.com/julianjab/ia-flow/issues/77',
    })

    script = say('ok')
    await chat.send('gracias')
    expect(requests.at(-1)?.messages.at(-1)?.content).toBe(
      '[Nota: el usuario ejecutó "Abrir un issue en julianjab/ia-flow" sobre "Cortar el loop" → https://github.com/julianjab/ia-flow/issues/77]\ngracias',
    )
  })
})

describe('sameScope', () => {
  it('compara tipo y su clave', () => {
    expect(sameScope({ kind: 'general' }, { kind: 'general' })).toBe(true)
    expect(
      sameScope({ kind: 'project', project_id: 'a' }, { kind: 'project', project_id: 'b' }),
    ).toBe(false)
    expect(sameScope({ kind: 'task', ref: 'a/b#1' }, { kind: 'project', project_id: 'a' })).toBe(
      false,
    )
  })
})
