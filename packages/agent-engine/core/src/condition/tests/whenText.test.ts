import { describe, expect, it } from 'vitest'
import { Capabilities } from '../../capability/Capabilities.js'
import { Engine } from '../../engine/Engine.js'
import { StaticPipelineSource } from '../../engine/PipelineSource.js'
import { createEvent } from '../../events/DomainEvent.js'
import { EventBus } from '../../events/EventBus.js'
import { FunctionAction } from '../../pipeline/actions/FunctionAction.js'
import { Pipeline } from '../../pipeline/Pipeline.js'
import { CapabilityTextClassifier } from '../CapabilityTextClassifier.js'
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

  it('without anyone fulfilling the whenText capability, a whenText never lets through', async () => {
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

describe('CapabilityTextClassifier', () => {
  const bus = new EventBus()
  const classifierWith = (fn: FunctionAction['fn']) =>
    new CapabilityTextClassifier(new Capabilities({ whenText: new FunctionAction({ fn }) }, bus))

  it('asks the whenText capability with the criterion, the event as JSON and the instructions', async () => {
    const seen: unknown[] = []
    const classifier = classifierWith((ctx) => {
      seen.push(ctx.event.payload)
      return { matches: true, reason: 'pide paginar' }
    })

    const verdict = await classifier.classify({
      whenText: {
        text: 'El comentario pide un cambio',
        systemPrompts: ['Sos estricto.', 'Y breve.'],
      },
      subject: { body: 'falta paginar' },
    })

    expect(verdict).toEqual({ matches: true, reason: 'pide paginar' })
    expect(seen).toEqual([
      {
        criterion: 'El comentario pide un cambio',
        event: JSON.stringify({ body: 'falta paginar' }, null, 2),
        instructions: 'Sos estricto.\n\nY breve.',
      },
    ])
  })

  it('cuts a long event', async () => {
    let event = ''
    const classifier = classifierWith((ctx) => {
      event = String((ctx.event.payload as { event: string }).event)
      return { matches: false, reason: '' }
    })
    await classifier.classify({ whenText: { text: 'x' }, subject: { body: 'a'.repeat(20_000) } })
    expect(event.length).toBeLessThan(13_000)
    expect(event).toContain('…(recortado)')
  })

  it('cuts each long text, not the tail: a comment body behind a huge description survives', async () => {
    let event = ''
    const classifier = classifierWith((ctx) => {
      event = String((ctx.event.payload as { event: string }).event)
      return { matches: false, reason: '' }
    })
    await classifier.classify({
      whenText: { text: 'x' },
      subject: {
        task: { description: 'd'.repeat(30_000), comments: 'c'.repeat(30_000) },
        body: 'Por qué no hiciste lo que te indiqué',
      },
    })
    expect(event.length).toBeLessThan(13_000)
    expect(event).toContain('Por qué no hiciste lo que te indiqué')
  })

  it('without anyone, with an error or with an answer off-contract, it cannot decide', async () => {
    const whenText = { text: 'x' }
    expect(
      await new CapabilityTextClassifier(new Capabilities({}, bus)).classify({
        whenText,
        subject: {},
      }),
    ).toEqual({ matches: null, reason: 'nadie cumple la capacidad whenText' })
    expect(
      await classifierWith(() => {
        throw new Error('ECONNRESET')
      }).classify({ whenText, subject: {} }),
    ).toEqual({ matches: null, reason: 'el clasificador falló: ECONNRESET' })
    expect(
      await classifierWith(() => ({ reason: 'dudo' })).classify({ whenText, subject: {} }),
    ).toMatchObject({ matches: null, reason: expect.stringContaining('no cumple el contrato') })
  })
})

describe('whenText through Engine.capabilities', () => {
  it('the engine asks the Runnable bound to whenText', async () => {
    const ran: string[] = []
    const engine = new Engine({
      bus: new EventBus(),
      capabilities: {
        whenText: new FunctionAction({
          fn: (ctx) => ({
            matches: (ctx.event.payload as { criterion: string }).criterion === 'yes',
            reason: '',
          }),
        }),
      },
      pipelines: source({
        id: 'p',
        pipelines: ['yes', 'no'].map(
          (text) =>
            new Pipeline({ id: text, on: ['a'], whenText: { text }, do: [step(text, ran)] }),
        ),
      }),
    })

    await engine.dispatch(createEvent('a', {}))

    expect(ran).toEqual(['yes'])
  })
})
