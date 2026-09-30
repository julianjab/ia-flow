/**
 * Delivery crudo → pipeline de entrada → evento emitido → pipelines REALES de `.config/`: el evento
 * que publica el intake tiene que tener la forma que las pipelines filtran (`item.status`,
 * `to`/`from`, `state`, `conclusion`, …). Sin red: el runner con una GitHub simulada (tests).
 */
import { describe, expect, it, vi } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TextClassifier } from '@ia-flow/agent-engine'
import { REPORT_MARKER } from '@ia-flow/github-tools'
import { parse } from 'yaml'
import type { MountedRunner } from '../boot.js'
import {
  commentPayload,
  type FakeGithubData,
  type FakeTask,
  fakeGithub,
  itemPayload,
  mountWith,
  reviewPayload,
  runIntake,
  runPayload,
  stepsFor,
} from './fixtures.js'
import { CONFIG_DIR } from './helpers.js'

const PROJECT = join(CONFIG_DIR, 'projects', 'lahaus-ai-flow')
const TASK = 'la-haus/subscriptions#7'
/** El PR abierto de la task #7, desde su rama, con el CI en verde. */
const OPEN_PR: FakeGithubData = {
  prs: {
    'la-haus/subscriptions#12': { number: 12, head: { ref: 'ia-flow-local/7', sha: 'abc123' } },
  },
  checks: [{ status: 'completed', conclusion: 'success' }],
}

/** El intake de `.config/` sobre una GitHub donde la task #7 es `task`, y lo que emitió. */
async function intakeOf(
  event: string,
  payload: Record<string, unknown>,
  task: FakeTask,
  data: FakeGithubData = {},
): Promise<{ mounted: MountedRunner; emitted: Awaited<ReturnType<typeof runIntake>>['emitted'] }> {
  const mounted = await mountWith(
    fakeGithub({
      items: { PVTI_1: TASK },
      ...data,
      tasks: { [TASK]: { labels: ['blocked'], ...task } },
    }),
  )
  const { emitted } = await runIntake(mounted, event, payload)
  return { mounted, emitted }
}

/** Las pipelines de `.config/` que corren para lo que emite el intake a partir del delivery. */
async function rulesFor(
  event: string,
  payload: Record<string, unknown>,
  task: FakeTask,
  data: FakeGithubData = {},
) {
  const { mounted, emitted } = await intakeOf(event, payload, task, data)
  try {
    const selected = await Promise.all(emitted.map((e) => mounted.engine.select(e)))
    return selected.flat().map((p) => p.id)
  } finally {
    mounted.stop()
  }
}

/** Los agentes que eligen, paso por paso, las pipelines que corren para el delivery. */
async function agentsFor(
  event: string,
  payload: Record<string, unknown>,
  task: FakeTask,
  data: FakeGithubData = {},
) {
  const { mounted, emitted } = await intakeOf(event, payload, task, data)
  try {
    const agents = await Promise.all(
      emitted.map(async (e) =>
        (await mounted.engine.select(e)).flatMap((pipeline) => stepsFor(pipeline, e)),
      ),
    )
    return agents.flat()
  } finally {
    mounted.stop()
  }
}

const statusChange = (from: string, to: string) =>
  itemPayload('edited', { field_name: 'Status', from: { name: from }, to: { name: to } })

describe('webhook crudo → intake → pipelines de .config/', () => {
  it('mounts the intake in the global source, and the flow in the project one', async () => {
    const mounted = await mountWith(fakeGithub())
    const ids = (id: string) =>
      mounted.sources
        .find((entry) => entry.id === id)
        ?.source.list()
        .map((p) => p.id) ?? []
    expect(ids('runner')).toEqual(['intake', 'intake-unblock'])
    expect(ids('lahaus-ai-flow').some((id) => id.startsWith('intake'))).toBe(false)
    mounted.stop()
  })

  it('Refined → Build dispatches build-arrival; Review → Build does not', async () => {
    expect(
      await rulesFor('projects_v2_item', statusChange('Refined', 'Build'), { status: 'Build' }),
    ).toContain('build-arrival')
    expect(
      await rulesFor('projects_v2_item', statusChange('Review', 'Build'), { status: 'Build' }),
    ).not.toContain('build-arrival')
  })

  it('never touches a card without `blocked` — the runner label filters it before any rule', async () => {
    expect(
      await rulesFor('projects_v2_item', statusChange('Refined', 'Build'), {
        status: 'Build',
        labels: [],
      }),
    ).toEqual([])
    expect(
      await rulesFor('pull_request_review', reviewPayload('changes_requested'), {
        status: 'Review',
        labels: ['backend'],
      }),
    ).toEqual([])
  })

  it('a card with open blockers only runs agents with `allowBlocked` (refiners yes, implementer no)', async () => {
    const blocked: FakeTask = {
      status: 'Build',
      blockedBy: [{ number: 3, title: 'migrar', state: 'open', html_url: 'u' }],
    }
    const { mounted, emitted } = await intakeOf(
      'projects_v2_item',
      statusChange('Refined', 'Build'),
      blocked,
    )
    expect(
      (emitted[0]?.payload as { item?: { blocked: boolean } } | undefined)?.item?.blocked,
    ).toBe(true)
    mounted.stop()

    expect(
      await rulesFor('projects_v2_item', statusChange('Refined', 'Build'), blocked),
    ).not.toContain('build-arrival')
    expect(
      await agentsFor('projects_v2_item', statusChange('Backlog', 'Refine'), {
        ...blocked,
        status: 'Refine',
      }),
    ).toEqual(['refiner'])
  })

  it('a card moved to Refine dispatches the refiner of its type', async () => {
    expect(
      await agentsFor('projects_v2_item', statusChange('Backlog', 'Refine'), { status: 'Refine' }),
    ).toEqual(['refiner'])
    expect(
      await agentsFor('projects_v2_item', statusChange('Backlog', 'Refine'), {
        status: 'Refine',
        type: 'Functional',
      }),
    ).toEqual(['functional-refiner'])
  })

  it("a human comment goes to the comment pipeline; the pipeline's own report does not", async () => {
    expect(
      await rulesFor('issue_comment', commentPayload('falta paginar'), { status: 'Refine' }),
    ).toEqual(['comment'])
    expect(
      await rulesFor('issue_comment', commentPayload(`${REPORT_MARKER}\nlisto`), {
        status: 'Refine',
      }),
    ).toEqual([])
  })

  it('changes requested on the PR dispatches pr-changes-requested', async () => {
    expect(
      await rulesFor('pull_request_review', reviewPayload('changes_requested'), {
        status: 'Review',
      }),
    ).toContain('pr-changes-requested')
  })

  it('the card reaching Review with an open PR dispatches the reviewer — every cycle', async () => {
    expect(
      await rulesFor(
        'projects_v2_item',
        statusChange('Build', 'Review'),
        { status: 'Review' },
        OPEN_PR,
      ),
    ).toContain('review')
    // Sin PR abierto no hay nada que revisar.
    expect(
      await rulesFor('projects_v2_item', statusChange('Build', 'Review'), { status: 'Review' }),
    ).not.toContain('review')
    // Abrir el PR ya no lo dispara: la card todavía no llegó a Review (el CI corre).
    const opened = {
      action: 'opened',
      pull_request: { number: 12, head: { ref: 'ia-flow-local/7' }, base: { ref: 'main' } },
      repository: {
        name: 'subscriptions',
        full_name: 'la-haus/subscriptions',
        owner: { login: 'la-haus' },
      },
    }
    expect(await rulesFor('pull_request', opened, { status: 'Build' })).not.toContain('review')
  })

  it("resolves every variable of the reviewer's prompt and of the review brief when the card reaches Review", async () => {
    const { mounted, emitted } = await intakeOf(
      'projects_v2_item',
      statusChange('Build', 'Review'),
      {
        status: 'Review',
        comments: [
          { body: 'falta paginar', created_at: '2026-09-25T10:00:00Z', user: { login: 'julian' } },
        ],
      },
      OPEN_PR,
    )
    mounted.stop()
    const payload = emitted[0]?.payload as Record<string, unknown>
    const reviewer = parse(readFileSync(join(PROJECT, 'agents', '30-reviewer.yaml'), 'utf8'))
    const review = parse(readFileSync(join(PROJECT, 'pipelines', '30-review.yaml'), 'utf8'))
    const brief = (review.do as Array<{ brief?: string }>)
      .map((step) => step.brief ?? '')
      .join('\n')
    const lookup = (path: string) =>
      path
        .split('.')
        .reduce<unknown>(
          (acc, key) =>
            acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined,
          payload,
        )
    const unresolved = [...`${reviewer?.prompt}\n${brief}`.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)]
      .map((m) => m[1] as string)
      .filter((path) => lookup(path) == null || lookup(path) === '')
    expect(unresolved).toEqual([])
    expect(lookup('pr.head.ref')).toBe('ia-flow-local/7')
    expect(lookup('pr.head.sha')).toBe('abc123')
    expect(lookup('task.pr.headSha')).toBe('abc123')
    expect(lookup('task.ci')).toBe('success')
  })

  it('a red CI run on the PR dispatches ci-red', async () => {
    expect(
      await rulesFor('workflow_run', runPayload('completed', [{ number: 12 }], 'ia-flow-local/7'), {
        status: 'Review',
      }),
    ).toContain('ci-red')
  })
})

describe('comment.yaml: a qué agente va un comentario', () => {
  const FRONT = 'la-haus/lh-seller-v2-frontend'
  const frontend = {
    name: 'lh-seller-v2-frontend',
    full_name: FRONT,
    owner: { login: 'la-haus' },
  }

  /** La pipeline que corre y los agentes que su `when` elige, para un comentario en `repo`. */
  async function routing(task: FakeTask, repo = 'subscriptions', classifier?: TextClassifier) {
    const key = `la-haus/${repo}#7`
    const mounted = await mountWith(
      fakeGithub({ tasks: { [key]: { labels: ['blocked'], ...task } } }),
      classifier,
    )
    try {
      const payload =
        repo === 'subscriptions'
          ? commentPayload('falta paginar')
          : { ...commentPayload('falta paginar'), repository: frontend }
      const { emitted } = await runIntake(mounted, 'issue_comment', payload)
      const event = emitted[0]
      if (!event) return { pipelines: [], agents: [] }
      const pipelines = await mounted.engine.select(event)
      return {
        pipelines: pipelines.map((p) => p.id),
        agents: pipelines.flatMap((p) => stepsFor(p, event)),
      }
    } finally {
      mounted.stop()
    }
  }

  it('Refine and Refined go to the refiner of the task type and repo', async () => {
    expect((await routing({ status: 'Refine' })).agents).toEqual(['refiner'])
    expect((await routing({ status: 'Refined' })).agents).toEqual(['refiner'])
    expect((await routing({ status: 'Refine', type: 'Functional' })).agents).toEqual([
      'functional-refiner',
    ])
    expect((await routing({ status: 'Refined' }, 'lh-seller-v2-frontend')).agents).toEqual([
      'frontend-refiner',
    ])
  })

  it('Build and Review go to the implementer; frontend only in Build or with the PR approved', async () => {
    expect((await routing({ status: 'Build' })).agents).toEqual(['implementer'])
    expect((await routing({ status: 'Build' }, 'lh-seller-v2-frontend')).agents).toEqual([
      'frontend-implementer',
    ])
    expect(
      (
        await routing(
          { status: 'Review', labels: ['blocked', 'reviewed'] },
          'lh-seller-v2-frontend',
        )
      ).agents,
    ).toEqual(['frontend-implementer'])
    expect((await routing({ status: 'Review' }, 'lh-seller-v2-frontend')).agents).toEqual([
      'implementer',
    ])
    expect((await routing({ status: 'Review', labels: ['blocked', 'reviewed'] })).agents).toEqual([
      'implementer',
    ])
  })

  it('a card with open blockers only reaches the technical refiners', async () => {
    const blockedBy = [{ number: 3, title: 'migrar', state: 'open', html_url: 'u' }]
    expect((await routing({ status: 'Refine', blockedBy })).agents).toEqual(['refiner'])
    expect((await routing({ status: 'Refine', type: 'Functional', blockedBy })).agents).toEqual([])
    expect((await routing({ status: 'Build', blockedBy })).agents).toEqual([])
  })

  it('a column without an agent does not even ask the model, and a comment the model says is not a change runs nothing', async () => {
    const classify = vi.fn(async () => ({ matches: false, reason: 'es una pregunta' }))
    expect((await routing({ status: 'Backlog' }, 'subscriptions', { classify })).pipelines).toEqual(
      [],
    )
    expect(classify).not.toHaveBeenCalled()

    expect((await routing({ status: 'Build' }, 'subscriptions', { classify })).pipelines).toEqual(
      [],
    )
    expect(classify).toHaveBeenCalledTimes(1)
  })
})

describe('un paso por agente: frontend o el resto, según el repo de la task', () => {
  const FRONT = 'la-haus/lh-seller-v2-frontend'
  const frontend = { name: 'lh-seller-v2-frontend', full_name: FRONT, owner: { login: 'la-haus' } }

  /** Los agentes que corren para `payload` sobre la task #7 de `repo`. */
  async function agentsIn(
    repo: 'subscriptions' | 'front',
    event: string,
    payload: Record<string, unknown>,
    task: FakeTask,
  ) {
    const key = repo === 'front' ? `${FRONT}#7` : 'la-haus/subscriptions#7'
    const mounted = await mountWith(
      fakeGithub({ items: { PVTI_1: key }, tasks: { [key]: { labels: ['blocked'], ...task } } }),
    )
    try {
      const raw =
        repo === 'front' && 'repository' in payload ? { ...payload, repository: frontend } : payload
      const { emitted } = await runIntake(mounted, event, raw)
      const agents = await Promise.all(
        emitted.map(async (e) => (await mounted.engine.select(e)).flatMap((p) => stepsFor(p, e))),
      )
      return agents.flat()
    } finally {
      mounted.stop()
    }
  }

  it('arrival in Build', async () => {
    const arrival = statusChange('Refined', 'Build')
    expect(await agentsIn('front', 'projects_v2_item', arrival, { status: 'Build' })).toEqual([
      'frontend-implementer',
    ])
    expect(
      await agentsIn('subscriptions', 'projects_v2_item', arrival, { status: 'Build' }),
    ).toEqual(['implementer'])
  })

  it('a red CI run and a review asking for changes', async () => {
    const red = runPayload('completed', [{ number: 12 }], 'ia-flow-local/7')
    expect(await agentsIn('front', 'workflow_run', red, { status: 'Review' })).toEqual([
      'frontend-implementer',
    ])
    expect(await agentsIn('subscriptions', 'workflow_run', red, { status: 'Review' })).toEqual([
      'implementer',
    ])
    const changes = reviewPayload('changes_requested')
    expect(await agentsIn('front', 'pull_request_review', changes, { status: 'Review' })).toEqual([
      'frontend-implementer',
    ])
    expect(
      await agentsIn('subscriptions', 'pull_request_review', changes, { status: 'Review' }),
    ).toEqual(['implementer'])
  })

  it('the on-demand e2e of the repo', async () => {
    const toReview = statusChange('Build', 'Review')
    const e2e: FakeTask = { status: 'Review', labels: ['blocked', 'e2e-test'] }
    expect(await agentsIn('front', 'projects_v2_item', toReview, e2e)).toEqual(['e2e-visual-qa'])
    expect(await agentsIn('subscriptions', 'projects_v2_item', toReview, e2e)).toEqual([
      'e2e-backend-qa',
    ])
  })
})
