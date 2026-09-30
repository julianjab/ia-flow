/**
 * `unblock-dependents`: un PR mergeado destraba las tasks que su issue bloqueaba. El intake
 * (`intake/50-unblock.yaml`) manda cada dependiente abierto a `resolve-task`, que emite
 * `issue.unblocked` sólo para las que quedaron sin prerrequisitos abiertos; las pipelines de
 * reentrada de su columna las retoman.
 */
import { describe, expect, it } from 'bun:test'
import {
  type FakeGithubData,
  type FakeTask,
  fakeGithub,
  mountWith,
  repository,
  runIntake,
  stepsFor,
} from './fixtures.js'

const API = 'https://api.github.com/repos'
const CLOSED = 'https://github.com/la-haus/subscriptions/issues/7'

/** El webhook de un PR cerrado que, según GitHub, cierra el issue #7 (su rama no importa). */
const closedPr = (merged: boolean, headRef = 'feat/x') => ({
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

const dependent = (number: number, state = 'open', repo = 'subscriptions') => ({
  number,
  state,
  repository_url: `${API}/la-haus/${repo}`,
})

const blocker = (url: string, state = 'open') => ({ number: 100, title: 'x', state, html_url: url })

/** Una GitHub donde #7 bloquea a `blocking`, y cada dependiente es `tasks[n]`. */
function world(
  blocking: ReturnType<typeof dependent>[],
  tasks: Record<number, FakeTask>,
): FakeGithubData {
  return {
    tasks: {
      'la-haus/subscriptions#7': { status: 'Build', blocking },
      ...Object.fromEntries(
        Object.entries(tasks).map(([n, task]) => [
          `la-haus/subscriptions#${n}`,
          { labels: ['blocked'], ...task },
        ]),
      ),
    },
  }
}

async function unblockedBy(payload: Record<string, unknown>, data: FakeGithubData) {
  const github = fakeGithub(data)
  const mounted = await mountWith(github)
  try {
    const { emitted } = await runIntake(mounted, 'pull_request', payload)
    return { github, mounted, unblocked: emitted.filter((e) => e.type === 'issue.unblocked') }
  } finally {
    mounted.stop()
  }
}

describe('intake: unblock-dependents', () => {
  it('emits issue.unblocked for each open dependent the merged issue was the last blocker of', async () => {
    // #9: su único bloqueador era #7 (todavía abierto en GitHub: el merge llegó antes del cierre).
    // #10: ya cerrado. #11: de un repo que el catálogo no declara.
    const { github, unblocked } = await unblockedBy(
      closedPr(true),
      world([dependent(9), dependent(10, 'closed'), dependent(11, 'open', 'otro')], {
        9: { status: 'Build', blockedBy: [blocker(CLOSED)] },
        10: { status: 'Build' },
      }),
    )
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
    expect(github.calls).toContain(
      'GET /repos/la-haus/subscriptions/issues/7/dependencies/blocking',
    )
  })

  it('leaves a dependent that still has another open blocker', async () => {
    const { unblocked } = await unblockedBy(
      closedPr(true),
      world([dependent(9)], {
        9: {
          status: 'Build',
          blockedBy: [blocker(CLOSED), blocker('https://github.com/la-haus/x/issues/3')],
        },
      }),
    )
    expect(unblocked).toEqual([])
  })

  it('does nothing for a PR closed without merging, or one that closes no issue', async () => {
    const data = world([dependent(9)], { 9: { status: 'Build' } })
    const notMerged = await unblockedBy(closedPr(false), data)
    expect(notMerged.github.calls.some((call) => call.includes('/dependencies/blocking'))).toBe(
      false,
    )

    const noIssue = await unblockedBy(closedPr(true), {
      ...data,
      prs: {
        'la-haus/subscriptions#12': { number: 12, closes: null, head: { ref: 'x', sha: 's' } },
      },
    })
    expect(noIssue.github.calls.some((call) => call.includes('/dependencies/blocking'))).toBe(false)
  })
})

describe('issue.unblocked → pipelines de .config/', () => {
  /** Los agentes que corren para la task #9 destrabada, en `status`. */
  async function agentsFor(status: string, type = 'Technical') {
    const github = fakeGithub(
      world([dependent(9)], { 9: { status, type, blockedBy: [blocker(CLOSED)] } }),
    )
    const mounted = await mountWith(github)
    try {
      const { emitted } = await runIntake(mounted, 'pull_request', closedPr(true))
      const unblocked = emitted.filter((e) => e.type === 'issue.unblocked')
      const agents = await Promise.all(
        unblocked.map(async (e) =>
          (await mounted.engine.select(e)).flatMap((pipeline) => stepsFor(pipeline, e)),
        ),
      )
      return agents.flat()
    } finally {
      mounted.stop()
    }
  }

  it('a card in Build goes back to the implementer', async () => {
    expect(await agentsFor('Build')).toEqual(['implementer'])
  })

  it('an epic in Refine goes back to the functional refiner', async () => {
    expect(await agentsFor('Refine', 'Functional')).toEqual(['functional-refiner'])
  })

  it('a technical card in Refine is not re-run: its refiner already runs on blocked cards', async () => {
    expect(await agentsFor('Refine')).toEqual([])
  })
})
