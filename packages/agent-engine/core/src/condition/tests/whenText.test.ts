import { describe, expect, it, vi } from 'vitest'
import { Engine } from '../../engine/Engine.js'
import { StaticPipelineSource } from '../../engine/PipelineSource.js'
import { createEvent } from '../../events/DomainEvent.js'
import { EventBus } from '../../events/EventBus.js'
import { FunctionAction } from '../../pipeline/actions/FunctionAction.js'
import { Pipeline } from '../../pipeline/Pipeline.js'
import { AnthropicTextClassifier } from '../AnthropicTextClassifier.js'
import { Condition } from '../Condition.js'
import type { TextClassifier, TextVerdict } from '../TextClassifier.js'

/** Las pipelines en una fuente (con el id que tendría un proyecto de la app). */
const source = ({ id, pipelines }: { id: string; pipelines: Pipeline[] }) =>
  new StaticPipelineSource(pipelines, { id })

/** Un clasificador que contesta según el criterio: `yes`/`no`/`unsure`. */
function fakeClassifier(): TextClassifier & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    classify: async ({ whenText }): Promise<TextVerdict> => {
      calls.push(whenText.text)
      if (whenText.text.startsWith('yes')) return { matches: true, reason: 'cumple' }
      if (whenText.text.startsWith('no')) return { matches: false, reason: 'no pide cambios' }
      return { matches: null, reason: 'timeout' }
    },
  }
}

const step = (id: string, ran: string[], whenText?: string) =>
  new FunctionAction({
    id,
    fn: () => void ran.push(id),
    ...(whenText ? { whenText: { text: whenText } } : {}),
  })

describe('whenText', () => {
  it('a pipeline runs only when the classifier says yes; no verdict counts as no', async () => {
    const classifier = fakeClassifier()
    const ran: string[] = []
    const pipelines = ['yes', 'no', 'unsure'].map(
      (text) => new Pipeline({ id: text, on: ['a'], whenText: { text }, do: [step(text, ran)] }),
    )
    const engine = new Engine({
      bus: new EventBus(),
      pipelines: source({ id: 'p', pipelines }),
      textClassifier: classifier,
    })

    await engine.dispatch(createEvent('a', {}))

    expect(ran).toEqual(['yes'])
  })

  it('is evaluated after the when, and a rejected exclusive does not hide a lower-priority one', async () => {
    const classifier = fakeClassifier()
    const ran: string[] = []
    const engine = new Engine({
      bus: new EventBus(),
      textClassifier: classifier,
      pipelines: source({
        id: 'p',
        pipelines: [
          new Pipeline({
            id: 'filtered',
            on: ['a'],
            when: Condition.fromRows([{ field: 'x', op: 'eq', value: 1 }]),
            whenText: { text: 'yes, but never asked' },
            do: [step('filtered', ran)],
          }),
          new Pipeline({
            id: 'triage',
            on: ['a'],
            exclusive: true,
            position: 1,
            whenText: { text: 'no' },
            do: [step('triage', ran)],
          }),
          new Pipeline({
            id: 'fallback',
            on: ['a'],
            exclusive: true,
            position: 2,
            do: [step('fallback', ran)],
          }),
        ],
      }),
    })

    await engine.dispatch(createEvent('a', { x: 2 }))

    expect(ran).toEqual(['fallback'])
    expect(classifier.calls).toEqual(['no'])
  })

  it('a step with a whenText is skipped when the classifier says no, and the same question is asked once per event', async () => {
    const classifier = fakeClassifier()
    const ran: string[] = []
    const engine = new Engine({
      bus: new EventBus(),
      textClassifier: classifier,
      pipelines: source({
        id: 'p',
        pipelines: [
          new Pipeline({
            id: 'p',
            on: ['a'],
            do: [step('first', ran, 'yes'), step('again', ran, 'yes'), step('skipped', ran, 'no')],
          }),
        ],
      }),
    })

    await engine.dispatch(createEvent('a', {}))

    expect(ran).toEqual(['first', 'again'])
    expect(classifier.calls).toEqual(['yes', 'no'])
  })

  it('a classifier that throws only keeps its own pipeline from running, and "unsure" is asked again', async () => {
    let calls = 0
    const flaky: TextClassifier = {
      classify: async ({ whenText }) => {
        calls++
        if (whenText.text === 'boom') throw new Error('ECONNRESET')
        return { matches: null, reason: '529' }
      },
    }
    const ran: string[] = []
    const engine = new Engine({
      bus: new EventBus(),
      textClassifier: flaky,
      pipelines: source({
        id: 'p',
        pipelines: [
          new Pipeline({
            id: 'gated',
            on: ['a'],
            whenText: { text: 'boom' },
            do: [step('gated', ran)],
          }),
          new Pipeline({
            id: 'free',
            on: ['a'],
            do: [
              step('free', ran),
              step('unsure-1', ran, 'unsure'),
              step('unsure-2', ran, 'unsure'),
            ],
          }),
        ],
      }),
    })

    await engine.dispatch(createEvent('a', {}))

    expect(ran).toEqual(['free'])
    // boom + las dos preguntas "unsure": un sin-veredicto no queda en la cache.
    expect(calls).toBe(3)
  })

  it('without a classifier, a whenText never lets through', async () => {
    const ran: string[] = []
    const engine = new Engine({
      bus: new EventBus(),
      pipelines: source({
        id: 'p',
        pipelines: [
          new Pipeline({ id: 'p', on: ['a'], whenText: { text: 'yes' }, do: [step('p', ran)] }),
        ],
      }),
    })

    expect(await engine.select(createEvent('a', {}))).toEqual([])
    expect(ran).toEqual([])
  })
})

describe('AnthropicTextClassifier', () => {
  const answer = (input: unknown, status = 200) =>
    new Response(
      JSON.stringify(
        status === 200
          ? { content: [{ type: 'tool_use', name: 'verdict', input }] }
          : { error: { message: 'overloaded' } },
      ),
      {
        status,
        headers: { 'content-type': 'application/json' },
      },
    )

  it('asks Haiku with the verdict tool forced, the criterion and the event, and the extra system prompts', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      answer({ matches: true, reason: 'pide paginar' }),
    )
    const classifier = new AnthropicTextClassifier({ apiKey: 'k', fetch })

    const verdict = await classifier.classify({
      whenText: { text: 'El comentario pide un cambio', systemPrompts: ['Sos estricto.'] },
      subject: { body: 'falta paginar' },
    })

    expect(verdict).toEqual({ matches: true, reason: 'pide paginar' })
    const [url, init] = fetch.mock.calls[0] ?? []
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    expect(init?.headers).toMatchObject({ 'x-api-key': 'k', 'anthropic-version': '2023-06-01' })
    const body = JSON.parse(String(init?.body))
    expect(body.model).toBe('claude-haiku-4-5')
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'verdict' })
    expect(body.system).toMatch(/Sos un clasificador[\s\S]*\n\nSos estricto\.$/)
    expect(body.messages[0].content).toContain('El comentario pide un cambio')
    expect(body.messages[0].content).toContain('"body": "falta paginar"')
  })

  it('a whenText model wins over the default one', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      answer({ matches: false, reason: '' }),
    )
    await new AnthropicTextClassifier({ apiKey: 'k', fetch, model: 'm1' }).classify({
      whenText: { text: 'x', model: 'm2' },
      subject: {},
    })
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).model).toBe('m2')
  })

  it('without a key, an error or a verdict, it cannot decide', async () => {
    const whenText = { text: 'x' }
    expect(
      await new AnthropicTextClassifier({ apiKey: () => undefined }).classify({
        whenText,
        subject: {},
      }),
    ).toMatchObject({ matches: null })
    expect(
      await new AnthropicTextClassifier({
        apiKey: 'k',
        fetch: async () => answer({}, 529),
      }).classify({ whenText, subject: {} }),
    ).toEqual({ matches: null, reason: 'Anthropic 529: overloaded' })
    expect(
      await new AnthropicTextClassifier({
        apiKey: 'k',
        fetch: async () => answer({ reason: 'dudo' }),
      }).classify({ whenText, subject: {} }),
    ).toEqual({ matches: null, reason: 'el modelo no devolvió un veredicto' })
    expect(
      await new AnthropicTextClassifier({
        apiKey: 'k',
        fetch: async () => {
          throw new Error('ECONNRESET')
        },
      }).classify({ whenText, subject: {} }),
    ).toEqual({ matches: null, reason: 'el clasificador falló: ECONNRESET' })
  })
})
