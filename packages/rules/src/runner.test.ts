import { afterEach, describe, expect, test } from 'bun:test'
import { type EngineEvent, type Rule, type RuleActionEntry, createEvent } from '@ia-flow/shared'
import { z } from 'zod'
import { clearActionRegistry, registerAction } from './actions.js'
import type { ActionResult } from './actions.js'
import { runRule } from './runner.js'

const noopEmit = async () => {}

function ev(): EngineEvent {
  return createEvent({
    type: 'pr.opened',
    source: 'github',
    scope: { projectId: 'p1' },
    payload: {},
  })
}

function rule(actions: RuleActionEntry[]): Rule {
  return { id: 'r1', on: ['pr.opened'], do: actions }
}

/** Registra una acción de prueba que anota su ejecución. */
function fake(kind: string, result: ActionResult, log: string[]) {
  registerAction({
    kind,
    configSchema: z.object({ action: z.literal(kind) }).passthrough(),
    async execute() {
      log.push(kind)
      if (result instanceof Error) throw result
      return result
    },
  })
}

afterEach(() => clearActionRegistry())

describe('runRule — orden y cortes', () => {
  test('ejecuta las acciones en orden', async () => {
    const log: string[] = []
    fake('a', { ok: true }, log)
    fake('b', { ok: true }, log)

    const outcome = await runRule(
      rule([{ action: 'a' }, { action: 'b' }] as unknown as RuleActionEntry[]),
      ev(),
      { emit: noopEmit },
    )

    expect(log).toEqual(['a', 'b'])
    expect(outcome).toBe('dispatched')
  })

  test('una falla corta la secuencia por default', async () => {
    const log: string[] = []
    fake('a', { ok: false }, log)
    fake('b', { ok: true }, log)

    await runRule(rule([{ action: 'a' }, { action: 'b' }] as unknown as RuleActionEntry[]), ev(), {
      emit: noopEmit,
    })

    expect(log).toEqual(['a'])
  })

  test('continueOnError deja seguir', async () => {
    const log: string[] = []
    fake('a', { ok: false }, log)
    fake('b', { ok: true }, log)

    await runRule(
      rule([
        { action: 'a', continueOnError: true },
        { action: 'b' },
      ] as unknown as RuleActionEntry[]),
      ev(),
      { emit: noopEmit },
    )

    expect(log).toEqual(['a', 'b'])
  })

  test('una acción que tira no voltea la regla y se reporta', async () => {
    const errors: string[] = []
    registerAction({
      kind: 'boom',
      configSchema: z.object({ action: z.literal('boom') }).passthrough(),
      async execute() {
        throw new Error('nope')
      },
    })

    const outcome = await runRule(
      rule([{ action: 'boom' }] as unknown as RuleActionEntry[]),
      ev(),
      { emit: noopEmit, onError: (_e, { kind }) => errors.push(kind) },
    )

    expect(outcome).toBe('skipped')
    expect(errors).toEqual(['boom'])
  })

  test('una acción desconocida se reporta y no explota', async () => {
    const errors: string[] = []
    const outcome = await runRule(
      rule([{ action: 'no-existe' }] as unknown as RuleActionEntry[]),
      ev(),
      { emit: noopEmit, onError: (_e, { kind }) => errors.push(kind) },
    )
    expect(outcome).toBe('skipped')
    expect(errors).toEqual(['no-existe'])
  })
})

describe('runRule — outcome', () => {
  test('deferred gana sobre el resto', async () => {
    const log: string[] = []
    fake('ok', { ok: true }, log)
    fake('busy', { ok: false, deferred: true }, log)

    const outcome = await runRule(
      rule([
        { action: 'ok' },
        { action: 'busy', continueOnError: true },
      ] as unknown as RuleActionEntry[]),
      ev(),
      { emit: noopEmit },
    )

    // Perderlo detrás del ok dejaría el item sin reintento hasta el próximo
    // scan de la fuente.
    expect(outcome).toBe('deferred')
  })

  test('sin ninguna acción exitosa es skipped', async () => {
    const log: string[] = []
    fake('a', { ok: false }, log)
    expect(
      await runRule(rule([{ action: 'a' }] as unknown as RuleActionEntry[]), ev(), {
        emit: noopEmit,
      }),
    ).toBe('skipped')
  })
})

describe('runRule — causalidad del emit', () => {
  test('el evento causante se liga acá, la acción sólo dice qué emitir', async () => {
    const emitted: Array<{ cause: EngineEvent; type: string }> = []
    registerAction({
      kind: 'emitter',
      configSchema: z.object({ action: z.literal('emitter') }).passthrough(),
      async execute(ctx) {
        await ctx.emit('derivado', { x: 1 })
        return { ok: true }
      },
    })

    const event = ev()
    await runRule(rule([{ action: 'emitter' }] as unknown as RuleActionEntry[]), event, {
      emit: async (cause, type) => {
        emitted.push({ cause, type })
      },
    })

    expect(emitted).toHaveLength(1)
    expect(emitted[0].cause.id).toBe(event.id)
    expect(emitted[0].type).toBe('derivado')
  })
})

describe('runRule — recorder', () => {
  test('registra el inicio y el fin de cada acción', async () => {
    const log: string[] = []
    fake('a', { ok: true }, log)
    const events: string[] = []

    await runRule(rule([{ action: 'a' }] as unknown as RuleActionEntry[]), ev(), {
      emit: noopEmit,
      recorder: {
        async onActionStart({ kind }) {
          events.push(`start:${kind}`)
          return 'run-1'
        },
        async onActionEnd({ runId, kind, result }) {
          events.push(`end:${kind}:${runId}:${result.ok}`)
        },
      },
    })

    expect(events).toEqual(['start:a', 'end:a:run-1:true'])
  })
})
