import axios from 'axios'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAssistantStore } from '../store'

const originalPost = axios.post
const originalGet = axios.get

beforeEach(() => {
  // Cada test arranca sin hilos guardados — la lista persiste en
  // localStorage entre stores (a propósito, es lo que sobrevive un cierre
  // de browser), así que sin este reset un test vería los hilos del
  // anterior.
  localStorage.clear()
  setActivePinia(createPinia())
})

afterEach(() => {
  axios.post = originalPost
  axios.get = originalGet
})

describe('assistant store — send', () => {
  it('agrega el mensaje optimista y lo conserva cuando el POST resuelve', async () => {
    axios.post = (async () => ({ data: { ok: true } })) as any

    const store = useAssistantStore()
    await store.send('hola')

    expect(store.messages).toHaveLength(1)
    expect(store.messages[0]).toMatchObject({ author: 'user', body: 'hola' })
    expect(store.sending).toBe(false)
    expect(store.waitingReply).toBe(true)
  })

  it('revierte el mensaje optimista y apaga waitingReply si el POST falla', async () => {
    axios.post = (async () => {
      throw new Error('network down')
    }) as any

    const store = useAssistantStore()
    await store.send('hola')

    expect(store.messages).toHaveLength(0)
    expect(store.sending).toBe(false)
    expect(store.waitingReply).toBe(false)
  })

  it('receive() sólo aplica a mensajes de la sesión activa', async () => {
    axios.post = (async () => ({ data: { ok: true } })) as any
    const store = useAssistantStore()

    store.receive({
      id: 'x',
      sessionId: 'otra-sesion',
      author: 'assistant',
      body: 'no debería aparecer',
      createdAt: new Date().toISOString(),
    })
    expect(store.messages).toHaveLength(0)

    store.receive({
      id: 'y',
      sessionId: store.sessionId,
      author: 'assistant',
      body: 'respuesta real',
      createdAt: new Date().toISOString(),
    })
    expect(store.messages).toHaveLength(1)
    expect(store.waitingReply).toBe(false)
  })

  it('el primer mensaje le pone título al hilo activo en la lista', async () => {
    axios.post = (async () => ({ data: { ok: true } })) as any
    const store = useAssistantStore()

    await store.send('Cuáles son las tareas más prioritarias?')

    const active = store.threads.find((t) => t.id === store.sessionId)
    expect(active?.title).toBe('Cuáles son las tareas más prioritarias?')
  })

  it('un título largo se trunca con elipsis', async () => {
    axios.post = (async () => ({ data: { ok: true } })) as any
    const store = useAssistantStore()

    await store.send('a'.repeat(80))

    const active = store.threads.find((t) => t.id === store.sessionId)
    expect(active?.title).toHaveLength(48)
    expect(active?.title?.endsWith('…')).toBe(true)
  })

  it('un mensaje siguiente NO pisa el título ya puesto', async () => {
    axios.post = (async () => ({ data: { ok: true } })) as any
    const store = useAssistantStore()

    await store.send('primero')
    await store.send('segundo')

    const active = store.threads.find((t) => t.id === store.sessionId)
    expect(active?.title).toBe('primero')
  })
})

describe('assistant store — hilos', () => {
  it('arranca con un único hilo placeholder cuando no hay nada guardado', () => {
    const store = useAssistantStore()
    expect(store.threads).toHaveLength(1)
    expect(store.threads[0].id).toBe(store.sessionId)
    expect(store.threads[0].title).toBe('Nueva conversación')
  })

  it('newThread() arranca una sesión nueva y limpia los mensajes visibles', async () => {
    axios.post = (async () => ({ data: { ok: true } })) as any
    const store = useAssistantStore()
    await store.send('hola')
    const firstId = store.sessionId

    store.newThread()

    expect(store.sessionId).not.toBe(firstId)
    expect(store.messages).toHaveLength(0)
    expect(store.threads).toHaveLength(2)
  })

  it('selectThread() cambia el hilo activo e hidrata su historial', async () => {
    axios.get = (async (url: string) => {
      expect(url).toContain('other-thread')
      return {
        data: {
          messages: [
            {
              id: 'm1',
              sessionId: 'other-thread',
              author: 'user',
              body: 'hey',
              createdAt: new Date().toISOString(),
            },
          ],
        },
      }
    }) as any

    const store = useAssistantStore()
    store.newThread()
    const otherId = 'other-thread'

    await store.selectThread(otherId)

    expect(store.sessionId).toBe(otherId)
    expect(store.messages).toHaveLength(1)
  })

  it('selectThread() al mismo hilo activo es un no-op — no re-hidrata', async () => {
    let calls = 0
    axios.get = (async () => {
      calls++
      return { data: [] }
    }) as any
    const store = useAssistantStore()

    await store.selectThread(store.sessionId)

    expect(calls).toBe(0)
  })

  it('receive() actualiza la fila del hilo aunque no sea el activo', () => {
    const store = useAssistantStore()
    store.newThread()
    const inactiveId = 'a-different-session'
    // No existía todavía en la lista — receive() lo crea igual, para que un
    // mensaje de un hilo abierto en otra pestaña no se pierda de la lista.
    store.receive({
      id: 'm1',
      sessionId: inactiveId,
      author: 'assistant',
      body: 'algo pasó en otro lado',
      createdAt: new Date().toISOString(),
    })

    expect(store.threads.some((t) => t.id === inactiveId)).toBe(true)
    expect(store.messages).toHaveLength(0)
  })

  it('los hilos se listan por actividad más reciente primero', async () => {
    // Fake timers: dos touches consecutivos pueden caer en el mismo
    // milisegundo real, y ahí el orden dependería de la estabilidad del
    // sort en vez de la actividad — se fuerza el paso del tiempo entre uno
    // y otro para que el test sea determinístico.
    vi.useFakeTimers()
    try {
      axios.post = (async () => ({ data: { ok: true } })) as any
      const store = useAssistantStore()
      const firstId = store.sessionId
      await store.send('primero')

      vi.advanceTimersByTime(1000)
      store.newThread()
      await store.send('segundo')

      expect(store.threads[0].id).toBe(store.sessionId)
      expect(store.threads[1].id).toBe(firstId)
    } finally {
      vi.useRealTimers()
    }
  })

  it('deleteThread() de un hilo inactivo sólo lo saca de la lista', async () => {
    axios.post = (async () => ({ data: { ok: true } })) as any
    const store = useAssistantStore()
    const activeId = store.sessionId
    store.newThread()
    const inactiveId = store.sessionId
    store.newThread()
    const currentActiveId = store.sessionId

    await store.deleteThread(inactiveId)

    expect(store.threads.some((t) => t.id === inactiveId)).toBe(false)
    expect(store.sessionId).toBe(currentActiveId)
    expect(store.threads.some((t) => t.id === activeId)).toBe(true)
  })

  it('deleteThread() del hilo activo cae al más reciente que quede', async () => {
    axios.get = (async () => ({ data: { messages: [] } })) as any
    const store = useAssistantStore()
    const firstId = store.sessionId
    store.newThread()
    const secondId = store.sessionId

    await store.deleteThread(secondId)

    expect(store.sessionId).toBe(firstId)
    expect(store.threads).toHaveLength(1)
  })

  it('deleteThread() del único hilo arranca uno nuevo en vez de quedar sin ninguno', async () => {
    const store = useAssistantStore()
    const onlyId = store.sessionId

    await store.deleteThread(onlyId)

    expect(store.threads).toHaveLength(1)
    expect(store.sessionId).not.toBe(onlyId)
    expect(store.messages).toHaveLength(0)
  })
})

describe('assistant store — contexto fijado por hilo', () => {
  it('el primer mensaje fija el contexto de ese hilo', async () => {
    axios.post = (async () => ({ data: { ok: true } })) as any
    const store = useAssistantStore()

    await store.send('hola', { projectId: 'ia-flow', taskId: 't1' })

    const active = store.threads.find((t) => t.id === store.sessionId)
    expect(active?.context).toEqual({ projectId: 'ia-flow', taskId: 't1' })
  })

  it('un mensaje siguiente con OTRO contexto sigue usando el fijado, no el nuevo', async () => {
    let lastBody: any
    axios.post = (async (_url: string, body: any) => {
      lastBody = body
      return { data: { ok: true } }
    }) as any
    const store = useAssistantStore()

    await store.send('primero', { projectId: 'ia-flow', taskId: 't1' })
    await store.send('segundo', { projectId: 'otro-proyecto', taskId: 't9' })

    expect(lastBody).toMatchObject({ projectId: 'ia-flow', taskId: 't1' })
    const active = store.threads.find((t) => t.id === store.sessionId)
    expect(active?.context).toEqual({ projectId: 'ia-flow', taskId: 't1' })
  })

  it('newThread() arranca sin contexto fijado — el próximo mensaje lo fija de nuevo', async () => {
    axios.post = (async () => ({ data: { ok: true } })) as any
    const store = useAssistantStore()
    await store.send('primero', { projectId: 'ia-flow' })

    store.newThread()
    const active = store.threads.find((t) => t.id === store.sessionId)
    expect(active?.context).toBeUndefined()

    await store.send('en el hilo nuevo', { projectId: 'otro-proyecto' })
    const activeAfter = store.threads.find((t) => t.id === store.sessionId)
    expect(activeAfter?.context).toEqual({ projectId: 'otro-proyecto' })
  })

  it('mandar sin contexto (vista global) también lo fija — no queda "sin fijar" para siempre', async () => {
    axios.post = (async () => ({ data: { ok: true } })) as any
    const store = useAssistantStore()

    await store.send('hola')

    const active = store.threads.find((t) => t.id === store.sessionId)
    expect(active?.context).toEqual({})
  })
})
