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

  // `skipped` es "no aplicaba", no "se rompió". Sin distinguirlo, una acción
  // que legítimamente no tenía nada que hacer se llevaba puestas las
  // siguientes — el caso real: un `ci.finished` de un PR que ningún issue del
  // board linkea, en una regla `do: [agent, emit]`.
  test('una acción skipped NO corta la secuencia', async () => {
    const log: string[] = []
    fake('a', { ok: false, skipped: true }, log)
    fake('b', { ok: true }, log)

    const outcome = await runRule(
      rule([{ action: 'a' }, { action: 'b' }] as unknown as RuleActionEntry[]),
      ev(),
      { emit: noopEmit },
    )

    expect(log).toEqual(['a', 'b'])
    expect(outcome).toBe('dispatched')
  })

  // Nada corrió, pero tampoco falló nada: la regla no aplicaba a este evento.
  test('sólo acciones skipped dejan la regla en skipped, no en dispatched', async () => {
    fake('a', { ok: false, skipped: true }, [])

    const outcome = await runRule(rule([{ action: 'a' }] as unknown as RuleActionEntry[]), ev(), {
      emit: noopEmit,
    })

    expect(outcome).toBe('skipped')
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

// El pipeline: lo que un paso deja, el siguiente lo lee. Es lo que convierte
// el `do[]` de una lista de acciones independientes en una secuencia.
describe('runRule — pasos encadenados', () => {
  test('un paso nombrado le pasa su output al siguiente', async () => {
    const visto: unknown[] = []
    registerAction({
      kind: 'produce',
      configSchema: z.object({ action: z.literal('produce') }).passthrough(),
      execute: async () => ({ ok: true, output: { brief: 'construí X' } }),
    })
    registerAction({
      kind: 'consume',
      configSchema: z.object({ action: z.literal('consume'), brief: z.string() }).passthrough(),
      execute: async (_ctx, cfg) => {
        visto.push((cfg as { brief: string }).brief)
        return { ok: true }
      },
    })

    await runRule(
      rule([
        { action: 'produce', id: 'triage' },
        { action: 'consume', brief: '{{steps.triage.output.brief}}' },
      ] as unknown as RuleActionEntry[]),
      ev(),
      { emit: noopEmit },
    )

    expect(visto).toEqual(['construí X'])
  })

  // Sin nombre no hay a quién referenciar: un paso que nadie lee no deja rastro.
  test('un paso SIN id no se publica', async () => {
    const errores: string[] = []
    registerAction({
      kind: 'produce',
      configSchema: z.object({ action: z.literal('produce') }).passthrough(),
      execute: async () => ({ ok: true, output: 'algo' }),
    })
    registerAction({
      kind: 'consume',
      configSchema: z.object({ action: z.literal('consume'), brief: z.string() }).passthrough(),
      execute: async () => ({ ok: true }),
    })

    await runRule(
      rule([
        { action: 'produce' },
        { action: 'consume', brief: '{{steps.triage.output}}' },
      ] as unknown as RuleActionEntry[]),
      ev(),
      { emit: noopEmit, onError: (e) => errores.push((e as Error).message) },
    )

    expect(errores.join()).toContain('triage')
  })

  // Correr con un valor que no llegó es el modo de falla que este mecanismo
  // tiene que NO tener.
  test('una referencia rota no ejecuta la acción', async () => {
    let corrio = false
    registerAction({
      kind: 'consume',
      configSchema: z.object({ action: z.literal('consume'), brief: z.string() }).passthrough(),
      execute: async () => {
        corrio = true
        return { ok: true }
      },
    })

    await runRule(
      rule([{ action: 'consume', brief: '{{steps.nope.output}}' }] as unknown as RuleActionEntry[]),
      ev(),
      { emit: noopEmit },
    )

    expect(corrio).toBe(false)
  })

  // Un paso que falló no dejó un valor; ofrecerlo vacío sería el mismo hueco.
  test('un paso que falló no publica output', async () => {
    const errores: string[] = []
    registerAction({
      kind: 'produce',
      configSchema: z.object({ action: z.literal('produce') }).passthrough(),
      execute: async () => ({ ok: false, output: 'basura', skipped: true }),
    })
    registerAction({
      kind: 'consume',
      configSchema: z.object({ action: z.literal('consume'), brief: z.string() }).passthrough(),
      execute: async () => ({ ok: true }),
    })

    await runRule(
      rule([
        { action: 'produce', id: 'triage' },
        { action: 'consume', brief: '{{steps.triage.output}}' },
      ] as unknown as RuleActionEntry[]),
      ev(),
      { emit: noopEmit, onError: (e) => errores.push((e as Error).message) },
    )

    expect(errores.join()).toContain('triage')
  })
})

// El `id` nombra el PASO dentro de esta secuencia, no la acción reusable, así
// que no puede vivir del otro lado de la ref.
describe('runRule — una ref conserva el id del paso', () => {
  test('publica su output bajo el id que puso la regla', async () => {
    const visto: unknown[] = []
    registerAction({
      kind: 'produce',
      configSchema: z.object({ action: z.literal('produce') }).passthrough(),
      execute: async () => ({ ok: true, output: 'del catálogo' }),
    })
    registerAction({
      kind: 'consume',
      configSchema: z.object({ action: z.literal('consume'), brief: z.string() }).passthrough(),
      execute: async (_ctx, cfg) => {
        visto.push((cfg as { brief: string }).brief)
        return { ok: true }
      },
    })

    await runRule(
      rule([
        { action: 'ref', actionId: 'compartida', id: 't' },
        { action: 'consume', brief: '{{steps.t.output}}' },
      ] as unknown as RuleActionEntry[]),
      ev(),
      {
        emit: noopEmit,
        resolveAction: async () => ({ entry: { action: 'produce' } as never, name: 'compartida' }),
      },
    )

    expect(visto).toEqual(['del catálogo'])
  })
})
