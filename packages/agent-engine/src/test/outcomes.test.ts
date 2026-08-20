import { describe, expect, it } from 'bun:test'
import type { TaskSource } from '@ia-flow/issue-sources'
import type { Task } from '@ia-flow/shared'
import { applyOutcome, parseFieldAssignments } from '../outcomes.js'

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

// ─── parseFieldAssignments ───────────────────────────────────────────────────

describe('parseFieldAssignments', () => {
  it('parte pares por coma y campo/valor por el primer =', () => {
    expect(parseFieldAssignments('status=Done,Priority=high')).toEqual([
      { field: 'status', value: 'Done' },
      { field: 'Priority', value: 'high' },
    ])
  })

  it('un token sin = continúa el valor anterior', () => {
    // Es lo que permite que un campo multi-valor viaje entero dentro del
    // mismo `$set:`; antes `-agent:build` se perdía por completo.
    expect(parseFieldAssignments('Labels=+agent:review,-agent:build')).toEqual([
      { field: 'Labels', value: '+agent:review,-agent:build' },
    ])
  })

  it('la continuación no se come el par siguiente', () => {
    expect(parseFieldAssignments('Labels=+a,-b,status=Done')).toEqual([
      { field: 'Labels', value: '+a,-b' },
      { field: 'status', value: 'Done' },
    ])
  })

  it('una clave repetida acumula en vez de pisar', () => {
    expect(parseFieldAssignments('Labels=+a,Labels=-b')).toEqual([
      { field: 'Labels', value: '+a,-b' },
    ])
  })

  it('acumula sin importar la capitalización de la clave', () => {
    expect(parseFieldAssignments('labels=+a,Labels=-b')).toEqual([
      { field: 'labels', value: '+a,-b' },
    ])
  })

  it('un token que empieza con = es continuación, no un par sin campo', () => {
    // `=c` es el token de reemplazo del DSL multi-valor. Leerlo como "par con
    // nombre vacío" lo descartaba en silencio, perdiendo el reemplazo.
    expect(parseFieldAssignments('Labels=+a,-b,=c')).toEqual([
      { field: 'Labels', value: '+a,-b,=c' },
    ])
  })

  it('conserva el = pelado, que es como se vacía un campo multi-valor', () => {
    expect(parseFieldAssignments('Labels=+a,=')).toEqual([{ field: 'Labels', value: '+a,=' }])
  })

  it('ignora una continuación sin par previo', () => {
    expect(parseFieldAssignments('suelto,status=Done')).toEqual([
      { field: 'status', value: 'Done' },
    ])
  })

  it('descarta pares sin nombre de campo', () => {
    expect(parseFieldAssignments('=x,status=Done')).toEqual([{ field: 'status', value: 'Done' }])
  })

  it('un valor con = adentro sobrevive entero', () => {
    expect(parseFieldAssignments('Nota=a=b')).toEqual([{ field: 'Nota', value: 'a=b' }])
  })
})

// ─── applyOutcome — campo multi-valor ────────────────────────────────────────

describe('applyOutcome — campo multi-valor', () => {
  const labelled = {
    id: '1',
    title: 'T',
    status: 'Build',
    type: 'functional',
    labels: ['bug', 'ci-checked'],
  } as unknown as Task

  it('manda los tokens con signo a setFields, sin resolverlos ni transicionar', async () => {
    // Resolver las ops es responsabilidad del source (sabe qué campos son
    // multi-valor y qué bookkeeping propio hay que blindar); el engine sólo
    // rutea. Y `Labels=...` no debe caer en applyTransition, que intentaría
    // mover el issue a un status llamado "$set:Labels=-ci-checked".
    const transitions: string[] = []
    let received: Record<string, string> | undefined
    const manager = mockManager({
      applyTransition: async (t, s) => {
        transitions.push(s)
        return { ...t, status: s } as Task
      },
      setFields: async (t: Task, fields: Record<string, string>) => {
        received = fields
        return t
      },
    })

    await applyOutcome(labelled, '$set:Labels=-ci-checked', manager)

    expect(transitions).toEqual([])
    expect(received).toEqual({ Labels: '-ci-checked' })
  })

  it('mantiene juntas todas las ops del campo', async () => {
    let received: Record<string, string> | undefined
    const manager = mockManager({
      setFields: async (t: Task, fields: Record<string, string>) => {
        received = fields
        return t
      },
    })
    await applyOutcome(labelled, '$set:Labels=+needs-review,-ci-checked', manager)
    expect(received).toEqual({ Labels: '+needs-review,-ci-checked' })
  })

  it('combina status y campo multi-valor en un mismo slot', async () => {
    const transitions: string[] = []
    let received: Record<string, string> | undefined
    const manager = mockManager({
      applyTransition: async (t, s) => {
        transitions.push(s)
        return { ...t, status: s } as Task
      },
      setFields: async (t: Task, fields: Record<string, string>) => {
        received = fields
        return t
      },
    })
    await applyOutcome(labelled, '$set:status=In Review,Labels=+agent:review', manager)
    expect(transitions).toEqual(['In Review'])
    expect(received).toEqual({ Labels: '+agent:review' })
  })

  it('no explota cuando el source no soporta setFields', async () => {
    const manager = mockManager({ setFields: undefined })
    const result = await applyOutcome(labelled, '$set:Labels=+x', manager)
    expect(result.status).toBe('Build')
  })
})
