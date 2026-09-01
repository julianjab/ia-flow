import { describe, expect, test } from 'bun:test'
import type { EngineEvent } from '@ia-flow/shared'
import { createEvent } from '@ia-flow/shared'
import type { IEventBus } from '../../../domain/ports/IEventBus.js'
import type { IWebhookTranslator } from '../../../domain/ports/IWebhookTranslator.js'
import { IngestWebhookUseCase } from '../IngestWebhookUseCase.js'

function fakeBus() {
  const published: EngineEvent[] = []
  const bus: IEventBus = {
    subscribe: () => () => {},
    publish: async (event) => {
      published.push(event)
      return 'dispatched'
    },
  }
  return { bus, published }
}

/** Un traductor de mentira: acepta un tipo y produce el evento que le digan. */
function translator(
  source: string,
  accepts: string,
  event: EngineEvent | null = createEvent({
    type: `${source}.thing`,
    source,
    scope: {},
    payload: {},
  }),
): IWebhookTranslator {
  return {
    source,
    handles: (e) => e === accepts,
    translate: () => event,
  }
}

describe('IngestWebhookUseCase', () => {
  test('publica el evento del traductor que acepta el delivery', async () => {
    const { bus, published } = fakeBus()
    const uc = new IngestWebhookUseCase(
      [translator('slack', 'event_callback'), translator('github', 'pull_request')],
      bus,
    )

    const result = await uc.ingest({ event: 'pull_request', payload: {} })

    expect(result).toEqual({ status: 'published', type: 'github.thing', outcome: 'dispatched' })
    expect(published).toHaveLength(1)
    expect(published[0]?.source).toBe('github')
  })

  test('sin traductor que lo entienda, no publica nada', async () => {
    const { bus, published } = fakeBus()
    const uc = new IngestWebhookUseCase([translator('github', 'pull_request')], bus)

    expect(await uc.ingest({ event: 'gollum', payload: {} })).toEqual({
      status: 'ignored',
      reason: 'no-translator',
    })
    expect(published).toHaveLength(0)
  })

  // Los dos "ignorado" se distinguen a propósito: `no-translator` responde
  // "nadie acá entiende ese delivery" y `no-event` "se entendió, pero no había
  // nada que publicar". Colapsarlos deja sin respuesta la pregunta de por qué
  // un evento suscrito en el hook no produce nada.
  test('un traductor que devuelve null distingue su motivo', async () => {
    const { bus, published } = fakeBus()
    const uc = new IngestWebhookUseCase([translator('github', 'pull_request', null)], bus)

    expect(await uc.ingest({ event: 'pull_request', payload: {} })).toEqual({
      status: 'ignored',
      reason: 'no-event',
    })
    expect(published).toHaveLength(0)
  })

  test('handles() responde sin parsear el body — es el pre-filtro del borde', () => {
    const uc = new IngestWebhookUseCase(
      [translator('github', 'pull_request'), translator('slack', 'event_callback')],
      fakeBus().bus,
    )

    expect(uc.handles('pull_request')).toBe(true)
    expect(uc.handles('event_callback')).toBe(true)
    expect(uc.handles('workflow_job')).toBe(false)
  })

  test('gana el primer traductor que acepta, no el último', async () => {
    const { bus, published } = fakeBus()
    const uc = new IngestWebhookUseCase(
      [translator('primero', 'x'), translator('segundo', 'x')],
      bus,
    )

    await uc.ingest({ event: 'x', payload: {} })

    expect(published[0]?.source).toBe('primero')
  })
})
