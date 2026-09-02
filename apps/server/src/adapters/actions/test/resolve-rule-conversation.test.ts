import { describe, expect, test } from 'bun:test'
import type { IIssueManager, IssueItem } from '@ia-flow/issue-sources'
import { type EngineEvent, type Rule, type TaskComment, createEvent } from '@ia-flow/shared'
import { createResolveRuleConversation } from '../resolve-rule-conversation.js'

// Lo que se testea es cuándo este módulo hace I/O y cuándo no: es best-effort
// alrededor de `renderConversationWindow`, así que casi todos los caminos
// deberían degradar a `undefined` sin tirar.

const ITEM = { id: 'I_1', title: 'una task' } as unknown as IssueItem

const event = (scope: EngineEvent['scope'] = { projectId: 'p1', issueId: 'I_1' }): EngineEvent =>
  createEvent({ type: 'issue.scanned', source: 'engine', scope, payload: {} })

const withAgentStep = (agentId: string): Pick<Rule, 'id' | 'do'> => ({
  id: 'r1',
  do: [{ action: 'agent', agentId }],
})

const withoutAgentStep: Pick<Rule, 'id' | 'do'> = {
  id: 'r1',
  do: [{ action: 'emit', type: 'foo' }],
}

function build(over: {
  manager?: Partial<IIssueManager>
  resolveItem?: (projectId: string, scope: EngineEvent['scope']) => Promise<IssueItem | undefined>
}) {
  const managerFor = (projectId: string) =>
    over.manager ? ({ projectId, ...over.manager } as unknown as IIssueManager) : undefined
  const resolveItem = over.resolveItem ?? (async () => ITEM)
  return createResolveRuleConversation({ managerFor, resolveItem })
}

describe('resolveRuleConversation', () => {
  test('sin projectId en el scope, no hace nada', async () => {
    let called = false
    const resolve = build({
      manager: {
        loadComments: async () => {
          called = true
          return []
        },
      },
    })
    const out = await resolve(withAgentStep('implementer'), event({}))
    expect(out).toBeUndefined()
    expect(called).toBe(false)
  })

  test('una regla sin ningún paso agent no tiene a quién cortar la ventana', async () => {
    let called = false
    const resolve = build({
      manager: {
        loadComments: async () => {
          called = true
          return []
        },
      },
    })
    const out = await resolve(withoutAgentStep, event())
    expect(out).toBeUndefined()
    expect(called).toBe(false)
  })

  test('sin manager para el proyecto, undefined', async () => {
    const resolve = build({})
    const out = await resolve(withAgentStep('implementer'), event())
    expect(out).toBeUndefined()
  })

  test('un manager sin loadComments, undefined', async () => {
    const resolve = build({ manager: {} })
    const out = await resolve(withAgentStep('implementer'), event())
    expect(out).toBeUndefined()
  })

  test('un item que no resuelve, undefined', async () => {
    const resolve = build({
      manager: { loadComments: async () => [] },
      resolveItem: async () => undefined,
    })
    const out = await resolve(withAgentStep('implementer'), event())
    expect(out).toBeUndefined()
  })

  test('camino feliz: carga comentarios y renderiza la ventana contra el primer agente', async () => {
    const comments: TaskComment[] = [
      { body: 'feedback nuevo', created_at: '2026-08-30T10:00:00Z', origin: 'issue' },
    ]
    const resolve = build({ manager: { loadComments: async () => comments } })
    const out = await resolve(withAgentStep('implementer'), event())
    expect(out).toContain('feedback nuevo')
  })

  test('sin comentarios nuevos, la ventana vacía se normaliza a undefined', async () => {
    const resolve = build({ manager: { loadComments: async () => [] } })
    const out = await resolve(withAgentStep('implementer'), event())
    expect(out).toBeUndefined()
  })

  // Best-effort: un fallo de la fuente degrada a "sin conversación", no tira
  // — el whenText evalúa igual, sólo que sin esa señal extra.
  test('un loadComments que tira no explota — degrada a undefined', async () => {
    const resolve = build({
      manager: {
        loadComments: async () => {
          throw new Error('502 de GitHub')
        },
      },
    })
    const out = await resolve(withAgentStep('implementer'), event())
    expect(out).toBeUndefined()
  })
})
