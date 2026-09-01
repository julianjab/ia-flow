import { describe, expect, test } from 'bun:test'
import type { EngineEvent, RunMessage, Wait } from '@ia-flow/shared'
import { TASK_MESSAGE_EVENT } from '@ia-flow/shared'
import type { IEventBus } from '../../../domain/ports/IEventBus.js'
import type { IRunMessageRepository } from '../../../domain/ports/IRunMessageRepository.js'
import type { IWaitRepository } from '../../../domain/ports/IWaitRepository.js'
import { EnqueueRunMessageUseCase } from '../EnqueueRunMessageUseCase.js'

function harness(wait: Wait | null) {
  const enqueued: RunMessage[] = []
  const published: EngineEvent[] = []

  const messages: IRunMessageRepository = {
    enqueue: async (m) => {
      enqueued.push(m)
      return m
    },
    pending: async () => [],
    markDelivered: async () => {},
  }
  const waits: IWaitRepository = {
    listByProject: async () => [],
    listExpired: async () => [],
    getByTask: async () => wait,
    create: async (w) => w,
    consume: async () => true,
  }
  const bus: IEventBus = {
    subscribe: () => () => {},
    publish: async (e) => {
      published.push(e)
      return 'dispatched'
    },
  }

  return { uc: new EnqueueRunMessageUseCase(messages, waits, bus), enqueued, published }
}

const wait = (over: Partial<Wait> = {}): Wait => ({
  id: 'w1',
  projectId: 'p1',
  taskId: 't1',
  agentId: 'a1',
  on: [TASK_MESSAGE_EVENT],
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  checkpoint: null,
  createdAt: new Date().toISOString(),
  ...over,
})

describe('EnqueueRunMessageUseCase', () => {
  // Rechazar sin run obligaría a quien escribe en el hilo a saber si el agente
  // está despierto — que es justo lo que no puede saber.
  test('encola aunque no haya una espera viva, y no publica evento', async () => {
    const { uc, enqueued, published } = harness(null)

    const msg = await uc.execute({ taskId: 't1', body: 'pará' })

    expect(enqueued).toHaveLength(1)
    expect(enqueued[0]?.body).toBe('pará')
    expect(enqueued[0]?.deliveredAt).toBeNull()
    expect(msg.taskId).toBe('t1')
    expect(published).toHaveLength(0)
  })

  // Sin esta publicación una pausa no termina nunca: el mensaje queda encolado
  // esperando un turno que no va a llegar.
  test('con una espera viva publica el evento que la despierta', async () => {
    const { uc, published } = harness(wait())

    const msg = await uc.execute({ taskId: 't1', body: 'seguí', author: 'julian' })

    expect(published).toHaveLength(1)
    expect(published[0]?.type).toBe(TASK_MESSAGE_EVENT)
    expect(published[0]?.payload).toMatchObject({
      body: 'seguí',
      author: 'julian',
      messageId: msg.id,
    })
  })

  // El scope sale de la espera: es el único lugar donde consta el proyecto sin
  // volver a la fuente. Uno sin `projectId` sólo lo verían las reglas globales.
  test('el scope del evento sale de la espera, no del pedido', async () => {
    const { uc, published } = harness(wait({ projectId: 'proyecto-x' }))

    await uc.execute({ taskId: 't1', body: 'hola' })

    expect(published[0]?.scope).toEqual({ projectId: 'proyecto-x', issueId: 't1' })
  })

  test("el source default es 'api' y viaja al mensaje y al evento", async () => {
    const { uc, enqueued, published } = harness(wait())

    await uc.execute({ taskId: 't1', body: 'hola' })
    expect(enqueued[0]?.source).toBe('api')
    expect(published[0]?.source).toBe('api')

    await uc.execute({ taskId: 't1', body: 'chau', source: 'slack' })
    expect(enqueued[1]?.source).toBe('slack')
    expect(published[1]?.source).toBe('slack')
  })
})
