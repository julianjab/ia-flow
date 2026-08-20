import { describe, expect, it } from 'bun:test'
import type { TaskSource } from '@ia-flow/issue-sources'
import type { Task } from '@ia-flow/shared'
import { applyLabelOps, applyOutcome } from '../outcomes.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────
// condToOp/evalWhen se testean en packages/shared/src/test/when.test.ts — viven ahí.

function mockManager(overrides: Partial<TaskSource> = {}): TaskSource {
  return {
    applyTransition: async (t: Task, status: string) => ({ ...t, status }) as Task,
    saveOutput: async (t: Task) => t,
    setAgentWorking: async (t: Task) => t,
    ...overrides,
  } as unknown as TaskSource
}

// ─── applyOutcome ─────────────────────────────────────────────────────────────

describe('applyOutcome', () => {
  const baseTask = { id: '1', title: 'T', status: 'queued', type: 'functional' } as Task

  it('delegates plain string to applyTransition', async () => {
    const transitions: string[] = []
    const manager = mockManager({
      applyTransition: async (t, s) => {
        transitions.push(s)
        return { ...t, status: s } as Task
      },
    })
    const result = await applyOutcome(baseTask, 'approved', manager)
    expect(transitions).toEqual(['approved'])
    expect(result.status).toBe('approved')
  })

  it('$set:status=approved delegates status to applyTransition', async () => {
    const transitions: string[] = []
    const manager = mockManager({
      applyTransition: async (t, s) => {
        transitions.push(s)
        return { ...t, status: s } as Task
      },
    })
    const result = await applyOutcome(baseTask, '$set:status=approved', manager)
    expect(transitions).toEqual(['approved'])
    expect(result.status).toBe('approved')
  })

  it('$set:Status=Refined (capital S) delegates to applyTransition', async () => {
    const transitions: string[] = []
    const manager = mockManager({
      applyTransition: async (t, s) => {
        transitions.push(s)
        return { ...t, status: s } as Task
      },
    })
    const result = await applyOutcome(baseTask, '$set:Status=Refined', manager)
    expect(transitions).toEqual(['Refined'])
    expect(result.status).toBe('Refined')
  })

  it('$set:non-status field calls setFields on manager', async () => {
    const setFieldsCalls: Array<Record<string, string>> = []
    const manager = mockManager({
      setFields: async (t, fields) => {
        setFieldsCalls.push(fields)
        return { ...t, ...fields } as Task
      },
    })
    const result = await applyOutcome(baseTask, '$set:type=technical', manager)
    expect((result as any).type).toBe('technical')
    expect(result.status).toBe('queued') // status unchanged
    expect(setFieldsCalls).toEqual([{ type: 'technical' }])
  })

  it('$set:non-status field falls back to local patch when no setFields', async () => {
    const manager = mockManager()
    const result = await applyOutcome(baseTask, '$set:type=technical', manager)
    expect((result as any).type).toBe('technical')
    expect(result.status).toBe('queued')
  })

  it('$set: with multiple pairs batches non-status fields in one setFields call', async () => {
    const transitions: string[] = []
    const setFieldsCalls: Array<Record<string, string>> = []
    const manager = mockManager({
      applyTransition: async (t, s) => {
        transitions.push(s)
        return { ...t, status: s } as Task
      },
      setFields: async (t, fields) => {
        setFieldsCalls.push(fields)
        return { ...t, ...fields } as Task
      },
    })
    const result = await applyOutcome(baseTask, '$set:type=technical,status=approved', manager)
    expect((result as any).type).toBe('technical')
    expect(transitions).toEqual(['approved'])
    expect(setFieldsCalls).toEqual([{ type: 'technical' }]) // single batched call
  })

  it('$set: with malformed pair (no =) is ignored', async () => {
    const manager = mockManager()
    const result = await applyOutcome(baseTask, '$set:badentry', manager)
    expect(result).toEqual(baseTask) // unchanged
  })

  it('$set: with empty payload returns task unchanged', async () => {
    const manager = mockManager()
    const result = await applyOutcome(baseTask, '$set:', manager)
    expect(result).toEqual(baseTask)
  })
})

// ─── applyLabelOps ───────────────────────────────────────────────────────────

describe('applyLabelOps', () => {
  it('añade con +, conservando las existentes', () => {
    expect(applyLabelOps(['bug'], '+urgent')).toEqual(['bug', 'urgent'])
  })

  it('quita con -', () => {
    expect(applyLabelOps(['bug', 'ci-checked'], '-ci-checked')).toEqual(['bug'])
  })

  it('reemplaza el set completo con =', () => {
    expect(applyLabelOps(['bug', 'stale'], '=listo')).toEqual(['listo'])
  })

  it('combina add y remove en un solo spec', () => {
    expect(applyLabelOps(['a', 'b'], '+c,-a')).toEqual(['b', 'c'])
  })

  it('quitar gana sobre añadir para la misma label', () => {
    expect(applyLabelOps(['a'], '+dup,-dup')).toEqual(['a'])
  })

  it('aplica +/- sobre la base impuesta por =', () => {
    expect(applyLabelOps(['viejo'], '=base,+extra')).toEqual(['base', 'extra'])
  })

  it('no duplica una label que ya estaba', () => {
    expect(applyLabelOps(['bug'], '+bug')).toEqual(['bug'])
  })

  it('trata un token sin prefijo como añadir', () => {
    expect(applyLabelOps([], 'suelta')).toEqual(['suelta'])
  })

  it('ignora tokens vacíos y espacios sobrantes', () => {
    expect(applyLabelOps([], ' +a , , -b ,')).toEqual(['a'])
  })

  it('`=` sin nombre borra todas las labels', () => {
    // "Reemplazar por (nada)" es una operación legítima.
    expect(applyLabelOps(['a', 'b'], '=')).toEqual([])
  })

  it('un spec vacío deja las labels intactas', () => {
    expect(applyLabelOps(['a'], '')).toEqual(['a'])
  })
})

// ─── applyOutcome — $labels: ─────────────────────────────────────────────────

describe('applyOutcome — $labels:', () => {
  const labelled = {
    id: '1',
    title: 'T',
    status: 'Build',
    type: 'functional',
    labels: ['bug', 'ci-checked'],
  } as unknown as Task

  it('llama a setLabels con el set final, no a applyTransition', async () => {
    // Regresión: `$labels:` no tenía rama propia y caía a applyTransition,
    // intentando mover el issue a un status llamado "$labels:-ci-checked".
    const transitions: string[] = []
    let received: string[] | undefined
    const manager = mockManager({
      applyTransition: async (t, s) => {
        transitions.push(s)
        return { ...t, status: s } as Task
      },
      setLabels: async (t: Task, labels: string[]) => {
        received = labels
        return { ...t, labels } as Task
      },
    })

    const result = await applyOutcome(labelled, '$labels:-ci-checked', manager)

    expect(transitions).toEqual([])
    expect(received).toEqual(['bug'])
    expect(result.labels).toEqual(['bug'])
  })

  it('añade conservando las labels actuales', async () => {
    let received: string[] | undefined
    const manager = mockManager({
      setLabels: async (t: Task, labels: string[]) => {
        received = labels
        return { ...t, labels } as Task
      },
    })
    await applyOutcome(labelled, '$labels:+needs-review', manager)
    expect(received).toEqual(['bug', 'ci-checked', 'needs-review'])
  })

  it('no explota cuando el source no soporta labels', async () => {
    // LocalProjectSource no modela labels: el outcome se ignora con un warn.
    const manager = mockManager({ setLabels: undefined })
    const result = await applyOutcome(labelled, '$labels:+x', manager)
    expect(result).toBe(labelled)
  })

  it('una task sin labels parte de un set vacío', async () => {
    let received: string[] | undefined
    const manager = mockManager({
      setLabels: async (t: Task, labels: string[]) => {
        received = labels
        return { ...t, labels } as Task
      },
    })
    const noLabels = { id: '2', title: 'T', status: 'Build', type: 'functional' } as Task
    await applyOutcome(noLabels, '$labels:+first', manager)
    expect(received).toEqual(['first'])
  })
})
