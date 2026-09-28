/**
 * Delivery crudo → pipeline de entrada → evento emitido → pipelines REALES de `.config/`: el evento
 * que publica el intake tiene que tener la forma que las pipelines filtran (`item.status`,
 * `to`/`from`, `state`, `conclusion`, …). Sin red: runner en dry-run y board simulado.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPORT_MARKER } from '@ia-tools/github-tools'
import { parse } from 'yaml'
import type { BoardItem } from '../board-reader.js'
import type { MountedRunner } from '../boot.js'
import {
  commentPayload,
  fakeIntake,
  itemPayload,
  reviewPayload,
  runIntake,
  runPayload,
} from './fixtures.js'
import { CONFIG_DIR, mountDry } from './helpers.js'

const PROJECT = join(CONFIG_DIR, 'projects', 'lahaus-ai-flow')

let mounted: MountedRunner

beforeAll(async () => {
  mounted = await mountDry()
})
afterAll(() => mounted.stop())

/**
 * Las reglas que correrían para el evento que emite el intake a partir del delivery crudo. En
 * dry-run el issue no se lee, así que sus labels se fijan acá — por default con `blocked`,
 * la que exige el `when` del proyecto.
 */
async function rulesFor(
  event: string,
  payload: Record<string, unknown>,
  card: Partial<BoardItem>,
  labels: string[] = ['blocked'],
) {
  const { emitted } = await runIntake(event, payload, fakeIntake(card))
  const selected = await Promise.all(
    emitted.map((e) => {
      const item = (e.payload as { item: { labels: string[] } }).item
      item.labels = labels
      return mounted.engine.select(e)
    }),
  )
  return selected.flat().map((p) => p.id)
}

const statusChange = (from: string, to: string) =>
  itemPayload('edited', { field_name: 'Status', from: { name: from }, to: { name: to } })

describe('webhook crudo → intake → pipelines de .config/', () => {
  it('mounts the intake next to the project pipelines, without mixing them', () => {
    expect(mounted.intake.map((p) => p.id)).toContain('intake:pull_request')
    expect(mounted.pipelines().some((p) => p.id.startsWith('intake:'))).toBe(false)
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
      await rulesFor('projects_v2_item', statusChange('Refined', 'Build'), { status: 'Build' }, []),
    ).toEqual([])
    expect(
      await rulesFor(
        'pull_request_review',
        reviewPayload('CHANGES_REQUESTED'),
        { status: 'Review' },
        ['backend'],
      ),
    ).toEqual([])
  })

  it('a card with open blockers only runs agents with `allowBlocked` (refiners yes, implementer no)', async () => {
    const blocked = fakeIntake(
      { status: 'Build' },
      {
        taskContext: {
          load: async () => ({
            comments: '',
            ci: '',
            blockers: [{ number: 3, title: 'migrar', url: 'u' }],
          }),
        },
      },
    )
    const rulesOf = async (event: string, payload: Record<string, unknown>) => {
      const { emitted } = await runIntake(event, payload, blocked)
      const selected = await Promise.all(
        emitted.map((e) => {
          const item = (e.payload as { item: { labels: string[]; blocked?: boolean } }).item
          expect(item.blocked).toBe(true)
          item.labels = ['blocked']
          return mounted.engine.select(e)
        }),
      )
      return selected.flat().map((p) => p.id)
    }
    expect(await rulesOf('projects_v2_item', statusChange('Refined', 'Build'))).not.toContain(
      'build-arrival',
    )
    expect(await rulesOf('projects_v2_item', statusChange('Backlog', 'Refine'))).toContain(
      'refine-technical',
    )
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
      await rulesFor('pull_request_review', reviewPayload('CHANGES_REQUESTED'), {
        status: 'Review',
      }),
    ).toContain('pr-changes-requested')
  })

  it('an opened PR dispatches the reviewer', async () => {
    const opened = {
      action: 'opened',
      pull_request: { number: 12, head: { ref: 'ia-flow/7' }, base: { ref: 'main' } },
      repository: { name: 'subscriptions', owner: { login: 'la-haus' } },
    }
    expect(await rulesFor('pull_request', opened, { status: 'Review' })).toContain('review')
    expect(
      await rulesFor('pull_request', { ...opened, action: 'synchronize' }, { status: 'Review' }),
    ).not.toContain('review')
  })

  it("resolves every variable of the reviewer's prompt and of the review brief for an opened PR", async () => {
    const { emitted } = await runIntake(
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
          head: { ref: 'ia-flow/7', sha: 'abc123' },
          base: { ref: 'main' },
        },
        repository: { name: 'subscriptions', owner: { login: 'la-haus' } },
      },
      fakeIntake({ status: 'Review' }),
    )
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
    expect(lookup('pr.head.ref')).toBe('ia-flow/7')
    expect(lookup('task.ci')).toBe('success')
  })

  it('a red CI run on the PR dispatches ci-red', async () => {
    expect(
      await rulesFor('workflow_run', runPayload('completed', [{ number: 12 }]), {
        status: 'Review',
      }),
    ).toContain('ci-red')
  })
})
