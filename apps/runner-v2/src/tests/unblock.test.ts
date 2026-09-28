/**
 * `unblock-dependents`: un PR mergeado destraba las tasks que su issue bloqueaba. El intake
 * emite `issue.unblocked` para cada una que quedó sin prerrequisitos abiertos, y las pipelines de
 * reentrada de su columna la retoman.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'bun:test'
import type { IntakeContext, IssueRef } from '../actions/index.js'
import type { MountedRunner } from '../boot.js'
import { card, fakeIntake, repository, runIntake } from './fixtures.js'
import { mountDry } from './helpers.js'

const CLOSED = 'https://github.com/la-haus/subscriptions/issues/7'

/** El webhook de un PR cerrado que implementa el issue #7 (rama `ia-flow/7`). */
const closedPr = (merged: boolean, headRef = 'ia-flow/7') => ({
  action: 'closed',
  number: 12,
  pull_request: {
    number: 12,
    merged,
    body: '',
    head: { ref: headRef, sha: 's' },
    base: { ref: 'main' },
  },
  repository,
})

/** Un intake cuyo #7 bloquea a `dependents`; `blockersOf` dice qué bloquea a cada uno. */
function unblockIntake(
  dependents: IssueRef[],
  blockersOf: Record<number, string[]> = {},
): IntakeContext {
  return fakeIntake(
    {},
    {
      dependents: vi.fn(async () => dependents),
      reader: {
        itemForIssue: vi.fn(async (_board, _owner, _repo, number: number) =>
          card({ number, status: 'Build' }),
        ),
        issueForItem: vi.fn(async () => card()),
      },
      taskContext: {
        load: vi.fn(async ({ number }: { number: number }) => ({
          comments: '',
          ci: '',
          blockers: (blockersOf[number] ?? []).map((url, i) => ({
            number: 100 + i,
            title: 'x',
            url,
          })),
        })),
      },
    },
  )
}

const issue = (number: number, open = true, repo = 'subscriptions'): IssueRef => ({
  owner: 'la-haus',
  repo,
  number,
  open,
})

describe('intake: unblock-dependents', () => {
  it('emits issue.unblocked for each open dependent the merged issue was the last blocker of', async () => {
    // #9: su único bloqueador era #7 (todavía abierto en GitHub: el merge llegó antes del cierre).
    // #10: ya cerrado. #11: de un repo que ningún proyecto declara.
    const ctx = unblockIntake([issue(9), issue(10, false), issue(11, true, 'otro')], {
      9: [CLOSED],
    })
    const { emitted } = await runIntake('pull_request', closedPr(true), ctx)
    const unblocked = emitted.filter((e) => e.type === 'issue.unblocked')
    expect(unblocked.map((e) => e.scope)).toEqual([
      {
        projectId: 'lahaus-ai-flow',
        repo: 'la-haus/subscriptions',
        issue: 'la-haus/subscriptions#9',
      },
    ])
    expect(unblocked[0]?.payload).toMatchObject({
      number: 9,
      item: { status: 'Build', blocked: false },
      task: { blockers: '' },
    })
    expect(ctx.dependents).toHaveBeenCalledWith('la-haus', 'subscriptions', 7)
  })

  it('leaves a dependent that still has another open blocker', async () => {
    const ctx = unblockIntake([issue(9)], { 9: [CLOSED, 'https://github.com/la-haus/x/issues/3'] })
    const { emitted } = await runIntake('pull_request', closedPr(true), ctx)
    expect(emitted.filter((e) => e.type === 'issue.unblocked')).toEqual([])
  })

  it('does nothing for a PR closed without merging, or one that closes no issue', async () => {
    const notMerged = unblockIntake([issue(9)])
    await runIntake('pull_request', closedPr(false), notMerged)
    expect(notMerged.dependents).not.toHaveBeenCalled()

    const noIssue = unblockIntake([issue(9)])
    await runIntake('pull_request', closedPr(true, 'feat/sin-issue'), noIssue)
    expect(noIssue.dependents).not.toHaveBeenCalled()
  })
})

describe('issue.unblocked → pipelines de .config/', () => {
  let mounted: MountedRunner
  beforeAll(async () => {
    mounted = await mountDry()
  })
  afterAll(() => mounted.stop())

  /** Las pipelines que corren para la task #9 destrabada, en `status`. */
  async function pipelinesFor(status: string, type = 'technical') {
    const ctx = fakeIntake(
      { status, type },
      {
        dependents: vi.fn(async () => [issue(9)]),
        taskContext: {
          load: vi.fn(async () => ({
            comments: '',
            ci: '',
            blockers: [{ number: 7, title: 't', url: CLOSED }],
          })),
        },
      },
    )
    const { emitted } = await runIntake('pull_request', closedPr(true), ctx)
    const selected = await Promise.all(
      emitted
        .filter((e) => e.type === 'issue.unblocked')
        .map((e) => {
          // En dry-run el issue no se lee: la label del proyecto (este runner sólo toma `blocked`).
          ;(e.payload as { item: { labels: string[] } }).item.labels = ['blocked']
          return mounted.engine.select(e)
        }),
    )
    return selected.flat().map((p) => p.id)
  }

  it('a card in Build goes back to the implementer', async () => {
    expect(await pipelinesFor('Build')).toEqual(['build-reentry'])
  })

  it('an epic in Refine goes back to the functional refiner', async () => {
    expect(await pipelinesFor('Refine', 'functional')).toEqual(['refine-functional'])
  })

  it('a technical card in Refine is not re-run: its refiner already runs on blocked cards', async () => {
    expect(await pipelinesFor('Refine')).toEqual([])
  })
})
