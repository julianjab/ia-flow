/**
 * Delivery crudo → pipeline de entrada → evento emitido → pipelines REALES de `.config/`: el evento
 * que publica el intake tiene que tener la forma que las pipelines filtran (`item.status`,
 * `to`/`from`, `state`, `conclusion`, …). Sin red: runner en dry-run y board simulado.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPORT_MARKER } from '@ia-tools/github-tools'
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

const statusChange = (from: string, to: string) =>
  itemPayload('edited', { field_name: 'Status', from: { name: from }, to: { name: to } })

describe('webhook crudo → intake → pipelines de .config/', () => {
  it('mounts the intake next to the project pipelines, without mixing them', async () => {
    const mounted = await mountWith(fakeGithub())
    expect(mounted.intake().map((p) => p.id)).toContain('intake-pull-request')
    expect(mounted.pipelines().some((p) => p.id.startsWith('intake-'))).toBe(false)
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

  it('never touches a card without `blocked` — the project when filters it before any rule', async () => {
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
      await rulesFor('projects_v2_item', statusChange('Backlog', 'Refine'), {
        ...blocked,
        status: 'Refine',
      }),
    ).toContain('refine-technical')
  })

  it('a card moved to Refine dispatches the technical refiner', async () => {
    expect(
      await rulesFor('projects_v2_item', statusChange('Backlog', 'Refine'), { status: 'Refine' }),
    ).toContain('refine-technical')
  })

  it("a human comment in Refine goes to triage; the pipeline's own report does not", async () => {
    expect(
      await rulesFor('issue_comment', commentPayload('falta paginar'), { status: 'Refine' }),
    ).toContain('comment-refine-technical')
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

  it('an opened PR dispatches the reviewer', async () => {
    const opened = {
      action: 'opened',
      pull_request: { number: 12, head: { ref: 'ia-flow-local/7' }, base: { ref: 'main' } },
      repository: {
        name: 'subscriptions',
        full_name: 'la-haus/subscriptions',
        owner: { login: 'la-haus' },
      },
    }
    expect(await rulesFor('pull_request', opened, { status: 'Review' })).toContain('review')
    expect(
      await rulesFor('pull_request', { ...opened, action: 'synchronize' }, { status: 'Review' }),
    ).not.toContain('review')
  })

  it("resolves every variable of the reviewer's prompt and of the review brief for an opened PR", async () => {
    const { mounted, emitted } = await intakeOf(
      'pull_request',
      {
        action: 'opened',
        pull_request: {
          number: 12,
          title: 'feat(core): paginar leads',
          body: 'Closes #7',
          state: 'open',
          html_url: 'https://github.com/la-haus/subscriptions/pull/12',
          user: { login: 'ai-lh-developer[bot]' },
          head: { ref: 'ia-flow-local/7', sha: 'abc123' },
          base: { ref: 'main' },
        },
        repository: {
          name: 'subscriptions',
          full_name: 'la-haus/subscriptions',
          owner: { login: 'la-haus' },
        },
      },
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
