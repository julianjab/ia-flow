import { describe, expect, test } from 'bun:test'
import type { DispatchOutcome, IIssueManager, IssueItem } from '@ia-flow/issue-sources'
import type { ActionContext } from '@ia-flow/rules'
import { createEvent } from '@ia-flow/shared'
import { AgentAction } from '../agent-action.js'

// El `brief` es lo único de una regla que el MODELO lee, así que lo que se
// testea es el contrato de esa frontera: que llegue rendido al dispatcher, y
// que un brief ausente no invente un argumento.

const item = { id: 'I_1', title: 'una task' } as unknown as IssueItem
const manager = {} as IIssueManager

const ctx = (payload: Record<string, unknown> = {}): ActionContext =>
  ({
    event: createEvent({
      type: 'pr.opened',
      source: 'github',
      scope: { projectId: 'p1' },
      payload: { item, ...payload },
    }),
    rule: { id: 'r1' },
    position: 0,
    emit: async () => {},
  }) as unknown as ActionContext

/** Captura lo que se le pasó al dispatcher. */
function spyDispatch(
  outcome: DispatchOutcome = 'dispatched',
  extra: Partial<ConstructorParameters<typeof AgentAction>[0]> = {},
  agentOutput?: unknown,
) {
  const calls: Array<string | undefined> = []
  const dispatched: Array<{ item: IssueItem; exits?: unknown }> = []
  return {
    calls,
    dispatched,
    action: new AgentAction({
      managerFor: () => manager,
      dispatch: async (item, _m, _a, _r, _e, brief, exits) => {
        calls.push(brief)
        dispatched.push({ item, exits })
        return { outcome, output: agentOutput }
      },
      ...extra,
    }),
  }
}

describe('AgentAction — brief', () => {
  test('baja el brief con las variables del evento ya resueltas', async () => {
    const { action, calls } = spyDispatch()
    await action.execute(ctx({ pr: { number: 482 } }), {
      action: 'agent',
      agentId: 'implementer',
      brief: 'Revisá el PR #{{event.payload.pr.number}} ({{event.type}}).',
    } as never)
    expect(calls[0]).toBe('Revisá el PR #482 (pr.opened).')
  })

  test('sin brief no manda nada — el agente corre con su prompt de siempre', async () => {
    const { action, calls } = spyDispatch()
    await action.execute(ctx(), { action: 'agent', agentId: 'implementer' } as never)
    expect(calls[0]).toBeUndefined()
  })

  // Un brief que quedó en blanco al editar la regla es "sin brief", no un
  // encabezado vacío colgando arriba del prompt.
  test('un brief en blanco cuenta como ausente', async () => {
    const { action, calls } = spyDispatch()
    await action.execute(ctx(), {
      action: 'agent',
      agentId: 'implementer',
      brief: '   \n  ',
    } as never)
    expect(calls[0]).toBeUndefined()
  })
})

describe('AgentAction — exits de la regla', () => {
  test('baja las redirecciones al dispatcher', async () => {
    const { action, dispatched } = spyDispatch()
    await action.execute(ctx(), {
      action: 'agent',
      agentId: 'implementer',
      exits: { success: 'QA Interna' },
    } as never)
    expect(dispatched[0].exits).toEqual({ success: 'QA Interna' })
  })

  test('sin exits no manda nada — vale el `exits` del agente', async () => {
    const { action, dispatched } = spyDispatch()
    await action.execute(ctx(), { action: 'agent', agentId: 'implementer' } as never)
    expect(dispatched[0].exits).toBeUndefined()
  })
})

// Los eventos de GitHub traen el PR y el scope, nunca el item: sin este camino
// una regla sobre `pr.review_submitted` no dispara nada.
describe('AgentAction — eventos sin item en el payload', () => {
  const prItem = { id: 'I_resuelto', title: 'la task del PR' } as unknown as IssueItem

  const prCtx = (): ActionContext =>
    ({
      event: createEvent({
        type: 'pr.review_submitted',
        source: 'github',
        scope: { projectId: 'p1', prNumber: 482 },
        payload: { state: 'changes_requested' },
      }),
      rule: { id: 'r1' },
      position: 0,
      emit: async () => {},
    }) as unknown as ActionContext

  test('resuelve el issue por el scope y despacha sobre él', async () => {
    const { action, dispatched } = spyDispatch('dispatched', {
      resolveItem: async () => prItem,
    })
    const res = await action.execute(prCtx(), {
      action: 'agent',
      agentId: 'implementer',
    } as never)
    expect(res.ok).toBe(true)
    expect(dispatched[0].item.id).toBe('I_resuelto')
  })

  // Un PR abierto a mano, sin issue en el board. `skipped` y no un fallo: el
  // runner corta el `do[]` ante un `ok:false` sin `continueOnError`, así que
  // marcarlo como error se llevaría puestas las acciones siguientes y pintaría
  // de rojo una regla que funcionó como tiene que funcionar.
  test('si no resuelve nada, es skipped — no corta el resto del do[]', async () => {
    const { action, dispatched } = spyDispatch('dispatched', {
      resolveItem: async () => undefined,
    })
    const res = await action.execute(prCtx(), {
      action: 'agent',
      agentId: 'implementer',
    } as never)
    expect(res.ok).toBe(false)
    expect(res.skipped).toBe(true)
    expect(res.deferred).toBeFalsy()
    expect(dispatched.length).toBe(0)
  })

  // La fuente caída un momento no puede disparar el `onError` del agente:
  // comentaría el fallo de un run que nunca se intentó.
  test('un fallo de la fuente DIFIERE en vez de fallar', async () => {
    const { action } = spyDispatch('dispatched', {
      resolveItem: async () => {
        throw new Error('502 de GitHub')
      },
    })
    const res = await action.execute(prCtx(), {
      action: 'agent',
      agentId: 'implementer',
    } as never)
    expect(res.deferred).toBe(true)
  })

  test('sin resolveItem cableado, el comportamiento es el de antes', async () => {
    const { action } = spyDispatch()
    const res = await action.execute(prCtx(), {
      action: 'agent',
      agentId: 'implementer',
    } as never)
    expect(res.ok).toBe(false)
    expect(res.skipped).toBe(true)
  })
})

// El `skipped` del dispatcher es el mismo hecho que el del item sin resolver:
// el item no aplicaba. Sin marcarlo, una regla `do: [agent, emit]` pierde el
// `emit` y la fila queda en rojo.
describe('AgentAction — el dispatcher devuelve skipped', () => {
  test('lo propaga como skipped, no como fallo', async () => {
    const { action } = spyDispatch('skipped')
    const res = await action.execute(ctx(), { action: 'agent', agentId: 'implementer' } as never)
    expect(res.ok).toBe(false)
    expect(res.skipped).toBe(true)
    expect(res.deferred).toBeFalsy()
  })

  test('`deferred` sigue siendo deferred y no skipped', async () => {
    const { action } = spyDispatch('deferred')
    const res = await action.execute(ctx(), { action: 'agent', agentId: 'implementer' } as never)
    expect(res.deferred).toBe(true)
    expect(res.skipped).toBeFalsy()
  })

  test('un dispatch normal sigue siendo ok', async () => {
    const { action } = spyDispatch('dispatched')
    const res = await action.execute(ctx(), { action: 'agent', agentId: 'implementer' } as never)
    expect(res.ok).toBe(true)
    expect(res.skipped).toBeFalsy()
  })
})

// Lo que el agente produjo es lo que el paso siguiente va a leer como
// `{{steps.<id>.output}}`.
describe('AgentAction — output del paso', () => {
  test('publica lo que devolvió el run', async () => {
    const { action } = spyDispatch('dispatched', {}, { brief: 'construí X', next: 'implementer' })
    const res = await action.execute(ctx(), { action: 'agent', agentId: 'triager' } as never)
    expect(res.output).toEqual({ brief: 'construí X', next: 'implementer' })
  })

  test('un agente sin salida no publica nada', async () => {
    const { action } = spyDispatch('dispatched')
    const res = await action.execute(ctx(), { action: 'agent', agentId: 'triager' } as never)
    expect(res.output).toBeUndefined()
  })
})

// El borde de privilegio del despacho dinámico, y la voz del brief.
describe('AgentAction — allowAgents y procedencia', () => {
  const withAgents = (over: Record<string, unknown>) =>
    ({ action: 'agent', agentId: 'implementer', ...over }) as never

  test('deja pasar un agentId que está en la lista', async () => {
    const { action } = spyDispatch()
    const res = await action.execute(
      ctx(),
      withAgents({ allowAgents: ['implementer', 'reviewer'] }),
    )
    expect(res.ok).toBe(true)
  })

  // Se re-chequea en runtime aunque el CRUD ya lo valide: la lista ES el borde
  // de privilegio, y una fila escrita por fuera del CRUD no puede saltearlo.
  test('rechaza uno que no está, aunque el CRUD lo haya dejado pasar', async () => {
    const { action, dispatched } = spyDispatch()
    const res = await action.execute(ctx(), withAgents({ allowAgents: ['reviewer'] }))
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('reviewer')
    expect(dispatched.length).toBe(0)
  })

  test('sin allowAgents no cambia nada', async () => {
    const { action } = spyDispatch()
    expect((await action.execute(ctx(), withAgents({}))).ok).toBe(true)
  })

  // Un brief del operador y uno que escribió un triager llegan al mismo lugar
  // del prompt; sin marcarlo, el segundo hereda la voz del primero.
  test('enmarca el brief cuando lo escribió otro agente', async () => {
    const { action, calls } = spyDispatch()
    const c = ctx()
    ;(c as { fromAgents?: string[] }).fromAgents = ['triager']
    await action.execute(c, withAgents({ brief: 'construí X' }))
    expect(calls[0]).toContain('triager')
    expect(calls[0]).toContain('no el operador')
    expect(calls[0]).toContain('construí X')
  })

  test('un brief del operador va tal cual', async () => {
    const { action, calls } = spyDispatch()
    await action.execute(ctx(), withAgents({ brief: 'construí X' }))
    expect(calls[0]).toBe('construí X')
  })
})

// El evento derivado tiene que nacer RUTEABLE. Sin scope, una regla que lo
// escuche con `action: agent` corta en el primer gate — "evento sin projectId".
describe('AgentAction — emitOn: exit', () => {
  test('el evento derivado hereda el scope y nombra el issue', async () => {
    const emitidos: Array<{ type: string; scope?: Record<string, unknown> }> = []
    const { action } = spyDispatch()
    const c = {
      event: createEvent({
        type: 'issue.scanned',
        source: 'engine',
        scope: { projectId: 'p1', repos: ['web'] },
        payload: { item },
      }),
      rule: { id: 'r1' },
      position: 0,
      emit: async (type: string, _p: unknown, scope: Record<string, unknown>) => {
        emitidos.push({ type, scope })
      },
    } as unknown as ActionContext

    await action.execute(c, { action: 'agent', agentId: 'implementer', emitOn: 'exit' } as never)

    expect(emitidos).toHaveLength(1)
    expect(emitidos[0].type).toBe('run.finished')
    expect(emitidos[0].scope).toEqual({ projectId: 'p1', repos: ['web'], issueId: 'I_1' })
  })

  test('sin emitOn no emite nada', async () => {
    const emitidos: unknown[] = []
    const { action } = spyDispatch()
    const c = { ...ctx(), emit: async (t: string) => void emitidos.push(t) } as ActionContext
    await action.execute(c, { action: 'agent', agentId: 'implementer' } as never)
    expect(emitidos).toHaveLength(0)
  })
})
