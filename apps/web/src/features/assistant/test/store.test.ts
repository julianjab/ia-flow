import axios from 'axios'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useAssistantStore } from '../store'

const originalPost = axios.post
const originalGet = axios.get

beforeEach(() => {
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
})
