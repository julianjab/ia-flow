import { describe, expect, it } from 'bun:test'
import type { PipelineExecutionContext } from '@ia-flow/agent-engine'
import type { EventFields } from '@ia-flow/github-webhook'
import type { IssueRef } from './parentEvents.js'
import { notifySiblingConflicts, PR_CONFLICT, type SiblingPort } from './siblingConflicts.js'

const ref = (repo: string, number: number): IssueRef => ({ owner: 'la-haus', repo, number })
const ctx = {} as PipelineExecutionContext

/** La épica #1991 con #1992 (el mergeado, PR #2000), #1993 (PR #2001) y #1994 (PR #2002) en
 *  subscriptions, y #77 en el front (PR #90). `mergeable` dice qué contesta GitHub, en orden. */
function portOf(mergeable: Record<number, Array<boolean | null>>) {
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
    mergeable: async (_o, _r, pr) => {
      asked.push(pr)
      const answers = mergeable[pr] ?? []
      return answers.length > 0 ? (answers.shift() as boolean | null) : true
    },
    publish: async (_ctx, task, fields) => {
      published.push({ task, fields })
      return { scope: { issue: `${task.owner}/${task.repo}#${task.number}` } } as never
    },
    sleep: async () => {},
  }
  return { port, published, asked }
}

const merged = { owner: 'la-haus', repo: 'subscriptions', pr: 2000 }

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

  it('un PR que no cierra ningún issue tampoco', async () => {
    const { port } = portOf({})
    port.closingIssues = async () => []

    expect(await notifySiblingConflicts(port, ctx, merged)).toEqual({
      skipped: 'PR #2000 no cierra ningún issue',
    })
  })
})
