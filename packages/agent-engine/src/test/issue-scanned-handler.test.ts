import { describe, expect, it } from 'bun:test'
import type { DispatchOutcome, IIssueManager, ITaskSource, IssueItem } from '@ia-flow/issue-sources'
import { ISSUE_SCANNED, createEvent } from '@ia-flow/shared'
import { createIssueScannedHandler, issueScannedEvent } from '../issue-scanned-handler.js'

function makeItem(over: Partial<IssueItem> = {}): IssueItem {
  return {
    id: 'i1',
    title: 'Arreglar el login',
    description: 'desc',
    status: 'Ready',
    type: 'functional',
    repos: ['api'],
    projectId: 'p1',
    ...over,
  }
}

function makeManager(projectId = 'p1'): IIssueManager {
  const transitionManager: ITaskSource = {
    applyTransition: async (t) => t,
    saveOutput: async (t) => t,
    setAgentWorking: async (t) => t,
  }
  return {
    projectId,
    start: () => ({ dispose: () => {} }),
    getTransitionManager: () => transitionManager,
  }
}

describe('issueScannedEvent', () => {
  it('publica el scope que el matcher necesita', () => {
    const e = issueScannedEvent(makeItem())
    expect(e.type).toBe(ISSUE_SCANNED)
    expect(e.scope).toEqual({ projectId: 'p1', repos: ['api'], issueId: 'i1' })
  })

  it('el item viaja entero y también aplanado, para que `when` lo evalúe', () => {
    const e = issueScannedEvent(makeItem())
    expect(e.payload.item).toEqual(makeItem())
    expect(e.payload.status).toBe('Ready')
  })

  it('dos scans del mismo issue son dos eventos distintos', () => {
    // Si compartieran id, el dedupe por evento se comería el segundo scan y el
    // issue quedaría sin reintento.
    expect(issueScannedEvent(makeItem()).id).not.toBe(issueScannedEvent(makeItem()).id)
  })
})

describe('createIssueScannedHandler', () => {
  it('sólo acepta issue.scanned de SU proyecto', () => {
    const h = createIssueScannedHandler(makeManager('p1'), 'p1', async () => 'dispatched')

    expect(h.handles(issueScannedEvent(makeItem({ projectId: 'p1' })))).toBe(true)
    expect(h.handles(issueScannedEvent(makeItem({ projectId: 'p2' })))).toBe(false)
    expect(
      h.handles(
        createEvent({
          type: 'pr.opened',
          source: 'github',
          scope: { projectId: 'p1' },
          payload: {},
        }),
      ),
    ).toBe(false)
  })

  it('reenvía el item y su manager al dispatcher, y devuelve su outcome', async () => {
    const manager = makeManager()
    const seen: Array<{ item: IssueItem; manager: IIssueManager }> = []
    const h = createIssueScannedHandler(manager, 'p1', async (item, m) => {
      seen.push({ item, manager: m })
      return 'deferred' as DispatchOutcome
    })

    const outcome = await h.handle(issueScannedEvent(makeItem()))

    expect(outcome).toBe('deferred')
    expect(seen).toHaveLength(1)
    expect(seen[0].item).toEqual(makeItem())
    expect(seen[0].manager).toBe(manager)
  })

  it('un evento sin item es skipped, no un throw', async () => {
    // Un evento mal formado no debería reintentarse en loop.
    let called = false
    const h = createIssueScannedHandler(makeManager(), 'p1', async () => {
      called = true
      return 'dispatched'
    })

    const outcome = await h.handle(
      createEvent({
        type: ISSUE_SCANNED,
        source: 'engine',
        scope: { projectId: 'p1' },
        payload: {},
      }),
    )

    expect(outcome).toBe('skipped')
    expect(called).toBe(false)
  })
})
