import type { AssistantProposal, AssistantRequest, AssistantStreamEvent } from '@ia-flow/shared'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Script = (req: AssistantRequest, signal?: AbortSignal) => AsyncGenerator<AssistantStreamEvent>
let script: Script = async function* () {}
const requests: AssistantRequest[] = []

const executeProposal = vi.fn()
const fetchProjects = vi.fn()

vi.mock('../api', () => ({
  streamAssistant: (req: AssistantRequest, opts: { signal?: AbortSignal }) => {
    requests.push(JSON.parse(JSON.stringify(req)))
    return script(req, opts.signal)
  },
  executeProposal: (...a: unknown[]) => executeProposal(...a),
  fetchProjects: () => fetchProjects(),
}))

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
    script = say('respuesta')
    executeProposal.mockReset()
    fetchProjects.mockReset().mockResolvedValue([])
  })

  it('el texto llega en deltas y queda en un turno del asistente', async () => {
    const chat = useAssistantChatStore()
    await chat.send('  ¿qué pasó?  ')
    expect(chat.turns.map((t) => t.kind)).toEqual(['user', 'assistant'])
    expect(chat.turns[0]).toMatchObject({ text: '¿qué pasó?' })
    expect(chat.turns[1]).toMatchObject({ text: 'respuesta', streaming: false })
    expect(chat.streaming).toBe(false)
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
    expect(chat.chips.map((c) => c.label)).toEqual(['General', 'acme/api#7'])
  })

  it('con un solo proyecto arranca en él; con varios, un chip por proyecto', async () => {
    fetchProjects.mockResolvedValue([{ id: 'core', board: { owner: 'a', number: 1 } }])
    const one = useAssistantChatStore()
    await one.loadProjects()
    expect(one.scope).toEqual({ kind: 'project', project_id: 'core' })
    expect(one.chips.map((c) => c.label)).toEqual(['General', 'Proyecto'])

    setActivePinia(createPinia())
    fetchProjects.mockResolvedValue([
      { id: 'core', board: { owner: 'a', number: 1 } },
      { id: 'web', board: { owner: 'b', number: 2 } },
    ])
    const many = useAssistantChatStore()
    await many.loadProjects()
    expect(many.scope).toEqual({ kind: 'general' })
    expect(many.chips.map((c) => c.label)).toEqual(['General', 'core', 'web'])
  })

  it('las sugerencias cambian con el contexto', () => {
    const chat = useAssistantChatStore()
    const general = [...chat.suggestions]
    chat.setScope({ kind: 'task', ref: 'a/b#1' })
    expect(chat.suggestions).not.toEqual(general)
    expect(chat.suggestions[0]).toBe('¿Qué pasó con esta tarea?')
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
