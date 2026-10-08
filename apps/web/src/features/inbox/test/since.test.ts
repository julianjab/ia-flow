import type { TaskFact } from '@ia-flow/shared'
import { describe, expect, it } from 'vitest'
import { parseDashboard } from '@/features/inbox/view/dashboard'
import { decide } from '@/features/inbox/view/decide'

// La antigüedad de cada decisión sale de su `since`. Con Zod 4 (el que empaqueta Vite) un
// `.default()` no pasa por el `transform`: el default tiene que ser ya la lista.

function fact(patch: Partial<TaskFact> = {}): TaskFact {
  return {
    ref: 'la-haus/subscriptions#1',
    project_id: 'p',
    title: 'Una tarea',
    url: 'https://github.com/la-haus/subscriptions/issues/1',
    updated_at: '2026-09-29T08:00:00Z',
    item: { status: 'Build', type: 'technical', repos: [], labels: [], blocked: false },
    run: {},
    live: {},
    queue: { waiting: false },
    task: { idle_hours: 1, waiting_hours: 1, unlocks: 0, blocked_by: 0 },
    blocked_by_refs: [],
    actions: [],
    action_defs: [],
    ...patch,
  }
}

describe('since — la antigüedad de una decisión', () => {
  const merge = fact({
    item: { status: 'Review', type: 't', repos: [], labels: ['reviewed'], blocked: false },
  })

  it('una decisión sin `since` usa `updated_at` (el default es una lista, no un string)', () => {
    const doc = parseDashboard('decisions:\n  - { id: merge, group: need, kind: merge, why: x }\n')
    expect(doc.decisions[0]?.since).toEqual(['{{updated_at}}'])
    expect(decide(merge, doc)?.since).toBe('2026-09-29T08:00:00Z')
  })

  it('con Zod 4 (el de Vite) un default llega como string suelto: no se recorre letra por letra', () => {
    const doc = parseDashboard('decisions:\n  - { id: merge, group: need, kind: merge, why: x }\n')
    const zod4 = {
      ...doc,
      decisions: doc.decisions.map((d) => ({
        ...d,
        since: '{{updated_at}}' as unknown as string[],
      })),
    }
    expect(decide(merge, zod4)?.since).toBe('2026-09-29T08:00:00Z')
  })
})
