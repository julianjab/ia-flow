import { describe, expect, it } from 'bun:test'
import type { PipelineExecutionContext } from '@ia-flow/agent-engine'
import type { EventFields } from '@ia-flow/github-webhook'
import type { IssueRef } from './parentEvents.js'
import { notifySiblingConflicts, PR_CONFLICT, type SiblingPort } from './siblingConflicts.js'

const ref = (repo: string, number: number): IssueRef => ({ owner: 'la-haus', repo, number })
const ctx = {} as PipelineExecutionContext

/** La épica #1991 con #1992 (el mergeado, PR #2000), #1993 (PR #2001) y #1994 (PR #2002) en
 *  subscriptions, y #77 en el front (PR #90). `mergeable` dice qué contesta GitHub, en orden. */
function portOf(mergeable: Record<number, Array<boolean | null>>, announced = new Set<string>()) {
  const published: Array<{ task: IssueRef & { pr: number }; fields: EventFields }> = []
  const asked: number[] = []
  const port: SiblingPort = {
    closingIssues: async () => [ref('subscriptions', 1992)],
    parentOf: async (_o, _r, number) => (number === 1992 ? ref('subscriptions', 1991) : undefined),
    openChildren: async () => [
      ref('subscriptions', 1992),
      ref('subscriptions', 1993),
      ref('subscriptions', 1994),
      ref('lh-seller-v2-frontend', 77),
    ],
    openPullOf: async (task) =>
      ({ 1993: 2001, 1994: 2002, 77: 90 })[task.number as 1993 | 1994 | 77],
    mergeability: async (_o, _r, pr) => {
      asked.push(pr)
      const answers = mergeable[pr] ?? []
      const value = answers.length > 0 ? (answers.shift() as boolean | null) : true
      return {
        mergeable: value,
        base: 'main',
        ...(value === false ? { state: 'dirty' } : value ? { state: 'clean' } : {}),
      }
    },
    announced,
    publish: async (_ctx, task, fields) => {
      published.push({ task, fields })
      return { scope: { issue: `${task.owner}/${task.repo}#${task.number}` } } as never
    },
    sleep: async () => {},
  }
  return { port, published, asked }
}

const merged = { owner: 'la-haus', repo: 'subscriptions', pr: 2000, base: 'main' }

describe('notifySiblingConflicts', () => {
  it('publica issue.pr_conflict sólo sobre el hermano del mismo repo que quedó en conflicto', async () => {
    const { port, published, asked } = portOf({ 2001: [false], 2002: [true] })

    const result = await notifySiblingConflicts(port, ctx, merged)

    expect(result).toEqual({ emitted: ['la-haus/subscriptions#1993'] })
    expect(published).toEqual([
      {
        task: { ...ref('subscriptions', 1993), pr: 2001 },
        fields: {
          emit: PR_CONFLICT,
          extra: {
            mergedPr: 'la-haus/subscriptions#2000',
            mergedChild: 'la-haus/subscriptions#1992',
            epic: 'la-haus/subscriptions#1991',
          },
        },
      },
    ])
    // El del front no comparte la base: ni se le pregunta.
    expect(asked).not.toContain(90)
  })

  it('espera a que GitHub termine de calcular el mergeable', async () => {
    const { port, published } = portOf({ 2001: [null, null, false], 2002: [true] })

    await notifySiblingConflicts(port, ctx, merged)

    expect(published.map((p) => p.task.number)).toEqual([1993])
  })

  it('si GitHub nunca termina de calcularlo, no publica y dice por qué', async () => {
    const { port, published } = portOf({ 2001: [null, null, null, null], 2002: [true] })

    const result = await notifySiblingConflicts(port, ctx, merged)

    expect(published).toEqual([])
    expect(result).toMatchObject({ skipped: expect.stringContaining('no terminó de calcular') })
  })

  it('un PR que no cierra un sub-issue de una épica no hace nada', async () => {
    const { port, published } = portOf({})
    port.closingIssues = async () => [ref('subscriptions', 5)]

    const result = await notifySiblingConflicts(port, ctx, merged)

    expect(published).toEqual([])
    expect(result).toEqual({ skipped: 'la-haus/subscriptions#5 no es sub-issue de nada' })
  })

  it('el mismo merge no avisa dos veces (un webhook repetido)', async () => {
    const announced = new Set<string>()
    const first = portOf({ 2001: [false], 2002: [true] }, announced)
    await notifySiblingConflicts(first.port, ctx, merged)
    const again = portOf({ 2001: [false], 2002: [true] }, announced)

    const result = await notifySiblingConflicts(again.port, ctx, merged)

    expect(first.published).toHaveLength(1)
    expect(again.published).toEqual([])
    expect(result).toMatchObject({
      skipped: expect.stringContaining('ya avisé a la-haus/subscriptions#1993'),
    })
  })

  it('dos entregas del mismo merge a la vez avisan una sola vez', async () => {
    const announced = new Set<string>()
    const a = portOf({ 2001: [null, false], 2002: [true] }, announced)
    const b = portOf({ 2001: [null, false], 2002: [true] }, announced)

    await Promise.all([
      notifySiblingConflicts(a.port, ctx, merged),
      notifySiblingConflicts(b.port, ctx, merged),
    ])

    expect(a.published.length + b.published.length).toBe(1)
  })

  it('lo que no se publicó no queda anotado: el próximo merge puede avisarlo', async () => {
    const announced = new Set<string>()
    await notifySiblingConflicts(
      portOf({ 2001: [true], 2002: [true] }, announced).port,
      ctx,
      merged,
    )

    const later = portOf({ 2001: [false], 2002: [true] }, announced)
    await notifySiblingConflicts(later.port, ctx, merged)

    expect(later.published.map((p) => p.task.number)).toEqual([1993])
  })

  it('un hermano contra otra base no recibió este merge: no se avisa', async () => {
    const { port, published } = portOf({ 2001: [false], 2002: [true] })
    const mergeability = port.mergeability
    port.mergeability = async (o, r, pr) => ({
      ...(await mergeability(o, r, pr)),
      base: 'release/1',
    })

    const result = await notifySiblingConflicts(port, ctx, merged)

    expect(published).toEqual([])
    expect(result).toMatchObject({
      skipped: expect.stringContaining('es contra release/1, no contra main'),
    })
  })

  it('un hermano que no se puede leer no tira a los demás', async () => {
    const { port, published } = portOf({ 2001: [false], 2002: [true] })
    const openPullOf = port.openPullOf
    port.openPullOf = async (task) => {
      if (task.number === 1994) throw new Error('404')
      return openPullOf(task)
    }

    const result = await notifySiblingConflicts(port, ctx, merged)

    expect(published.map((p) => p.task.number)).toEqual([1993])
    expect(result).toEqual({ emitted: ['la-haus/subscriptions#1993'] })
  })

  it('un PR que no cierra ningún issue tampoco', async () => {
    const { port } = portOf({})
    port.closingIssues = async () => []

    expect(await notifySiblingConflicts(port, ctx, merged)).toEqual({
      skipped: 'PR #2000 no cierra ningún issue',
    })
  })
})
