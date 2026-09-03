import { beforeEach, describe, expect, it } from 'bun:test'
import { createEvent } from '@ia-flow/shared'
import type { Rule, RuleActionEntry } from '@ia-flow/shared'
import { clearActionRegistry, registerAction } from '../actions.js'
import { runRule } from '../runner.js'

const event = createEvent({ type: 'pr.opened', source: 'github', scope: {}, payload: {} })

const rule = (dos: RuleActionEntry[]): Rule => ({ id: 'r1', on: ['pr.opened'], do: dos }) as Rule

/** Registra un handler que anota cada ejecución. */
function spyAction(kind: string, ok = true) {
  const calls: unknown[] = []
  registerAction({
    kind,
    configSchema: { safeParse: (v: unknown) => ({ success: true as const, data: v }) } as never,
    execute: async (_ctx, config) => {
      calls.push(config)
      return { ok }
    },
  })
  return calls
}

beforeEach(() => clearActionRegistry())

describe('runRule — acciones por referencia', () => {
  it('ejecuta la acción referenciada como si fuera inline', async () => {
    const calls = spyAction('http')

    const outcome = await runRule(rule([{ action: 'ref', actionId: 'avisar' } as never]), event, {
      emit: async () => {},
      resolveAction: async (id) =>
        id === 'avisar'
          ? { entry: { action: 'http', url: 'https://x' } as RuleActionEntry, name: 'Avisar' }
          : null,
    })

    expect(outcome).toBe('dispatched')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ action: 'http', url: 'https://x' })
  })

  // Borrar la acción después de guardar la regla es un caso real. Falla la
  // ACCIÓN, no la regla: el resto del `do[]` sigue su curso según continueOnError.
  it('una ref que no resuelve falla sin voltear la regla', async () => {
    const calls = spyAction('emit')
    const errors: unknown[] = []

    await runRule(
      rule([
        { action: 'ref', actionId: 'borrada', continueOnError: true } as never,
        { action: 'emit', type: 'sigo' } as never,
      ]),
      event,
      {
        emit: async () => {},
        resolveAction: async () => null,
        onError: (err) => errors.push(err),
      },
    )

    expect(String(errors[0])).toContain("'borrada' no existe")
    expect(calls).toHaveLength(1)
  })

  it('sin continueOnError, una ref rota corta la secuencia', async () => {
    const calls = spyAction('emit')

    await runRule(
      rule([
        { action: 'ref', actionId: 'borrada' } as never,
        { action: 'emit', type: 'no-llego' } as never,
      ]),
      event,
      { emit: async () => {}, resolveAction: async () => null },
    )

    expect(calls).toHaveLength(0)
  })

  // Es una decisión de ESTA regla sobre ESTA secuencia, no una propiedad de la
  // acción: la misma puede ser opcional en una regla y crítica en otra.
  it('el continueOnError de la ref gana sobre el de la acción referenciada', async () => {
    spyAction('http', false)
    const emitCalls = spyAction('emit')

    await runRule(
      rule([
        { action: 'ref', actionId: 'a', continueOnError: true } as never,
        { action: 'emit', type: 'sigo' } as never,
      ]),
      event,
      {
        emit: async () => {},
        // La acción referenciada dice que NO se siga.
        resolveAction: async () => ({
          entry: { action: 'http', url: 'https://x', continueOnError: false } as RuleActionEntry,
        }),
      },
    )

    expect(emitCalls).toHaveLength(1)
  })

  // Sin resolver cableado (un test, un deploy que no usa refs) una ref tiene
  // que fallar con su motivo, no ignorarse en silencio.
  it('sin resolver, la ref falla en vez de saltearse', async () => {
    const errors: unknown[] = []

    await runRule(rule([{ action: 'ref', actionId: 'x' } as never]), event, {
      emit: async () => {},
      onError: (err) => errors.push(err),
    })

    expect(errors).toHaveLength(1)
  })

  it('el resolver recibe el evento, para poder acotar por ámbito', async () => {
    spyAction('emit')
    const seen: string[] = []

    const scoped = createEvent({
      type: 'pr.opened',
      source: 'github',
      scope: { projectId: 'p1' },
      payload: {},
    })

    await runRule(rule([{ action: 'ref', actionId: 'x' } as never]), scoped, {
      emit: async () => {},
      resolveAction: async (_id, ev) => {
        seen.push(ev.scope.projectId ?? '')
        return { entry: { action: 'emit', type: 'ok' } as RuleActionEntry }
      },
    })

    expect(seen).toEqual(['p1'])
  })

  // El nombre es lo que la fila del listado muestra en la columna del agente.
  // Sin esto, una acción con nombre y una inline eran indistinguibles ahí.
  it('le pasa al recorder el nombre de la acción referenciada', async () => {
    spyAction('emit')
    const seen: Array<string | undefined> = []

    await runRule(rule([{ action: 'ref', actionId: 'avisar' } as never]), event, {
      emit: async () => {},
      resolveAction: async () => ({
        entry: { action: 'emit', type: 'ok' } as RuleActionEntry,
        name: 'Avisar en Slack',
      }),
      recorder: {
        onActionStart: async (info) => {
          seen.push(info.name)
          return 'run-1'
        },
      },
    })

    expect(seen).toEqual(['Avisar en Slack'])
  })

  it('una acción inline no lleva nombre', async () => {
    spyAction('emit')
    const seen: Array<string | undefined> = []

    await runRule(rule([{ action: 'emit', type: 'ok' } as never]), event, {
      emit: async () => {},
      recorder: {
        onActionStart: async (info) => {
          seen.push(info.name)
          return 'run-1'
        },
      },
    })

    expect(seen).toEqual([undefined])
  })

  // Mismo caso que `id` arriba: el `when` condiciona ESTE paso de ESTA
  // secuencia, no la acción reusable — sin arrastrarlo desde el `raw` de la
  // ref, corría siempre sin importar la condición.
  describe('el when de una ref', () => {
    it('viaja desde la ref y gatea el paso', async () => {
      const calls = spyAction('http')

      const outcome = await runRule(
        rule([
          {
            action: 'ref',
            actionId: 'avisar',
            when: [{ field: 'actionable', op: '=', value: 'true' }],
          } as never,
        ]),
        createEvent({
          type: 'pr.opened',
          source: 'github',
          scope: {},
          payload: { actionable: false },
        }),
        {
          emit: async () => {},
          resolveAction: async (id) =>
            id === 'avisar'
              ? { entry: { action: 'http', url: 'https://x' } as RuleActionEntry, name: 'Avisar' }
              : null,
        },
      )

      expect(outcome).toBe('skipped')
      expect(calls).toHaveLength(0)
    })

    it('gana sobre el when que trajera la acción con nombre', async () => {
      const calls = spyAction('http')

      const outcome = await runRule(
        rule([
          {
            action: 'ref',
            actionId: 'avisar',
            when: [{ field: 'actionable', op: '=', value: 'true' }],
          } as never,
        ]),
        createEvent({
          type: 'pr.opened',
          source: 'github',
          scope: {},
          payload: { actionable: true },
        }),
        {
          emit: async () => {},
          resolveAction: async (id) =>
            id === 'avisar'
              ? {
                  entry: {
                    action: 'http',
                    url: 'https://x',
                    when: [{ field: 'actionable', op: '=', value: 'false' }],
                  } as RuleActionEntry,
                  name: 'Avisar',
                }
              : null,
        },
      )

      expect(outcome).toBe('dispatched')
      expect(calls).toHaveLength(1)
    })
  })
})
