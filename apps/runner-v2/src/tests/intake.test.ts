/**
 * Las pipelines de entrada (`intake.ts`) de punta a punta: un delivery CRUDO entra como
 * `github.<evento>`, la Action de `actions/` lo resuelve y el `EmitAction` publica el evento
 * enriquecido. Sin red: el board se simula y el issue no se lee (dry-run de `buildPayload`).
 */
import { beforeEach, describe, expect, it, vi } from 'bun:test'
import type { IntakeContext } from '../actions/index.js'
import { linkedIssue } from '../actions/index.js'
import {
  commentPayload,
  fakeIntake,
  itemPayload,
  repository,
  reviewPayload,
  runIntake,
  runPayload,
} from './fixtures.js'

describe('intake: projects_v2_item', () => {
  let ctx: IntakeContext
  beforeEach(() => {
    ctx = fakeIntake()
  })

  it('emits issue.status_changed with from/to, scoped to the project', async () => {
    const { emitted } = await runIntake(
      'projects_v2_item',
      itemPayload('edited', {
        field_name: 'Status',
        from: { name: 'Refined' },
        to: { name: 'Build' },
      }),
      ctx,
    )
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({
      type: 'issue.status_changed',
      scope: { projectId: 'lahaus-ai-flow' },
      payload: {
        from: 'Refined',
        to: 'Build',
        task_type: 'technical',
        item: { status: 'Build', type: 'technical', repos: ['subscriptions'] },
        task: { id: 'la-haus/subscriptions#7', branch: 'ia-flow/7' },
        project: { repos: '- subscriptions' },
      },
    })
  })

  it('falls back to the last status it saw when GitHub omits from/to', async () => {
    ctx.lastStatus.set('PVTI_1', 'Review')
    const { emitted } = await runIntake(
      'projects_v2_item',
      itemPayload('edited', { field_name: 'Status' }),
      ctx,
    )
    expect(emitted[0]?.payload).toMatchObject({ from: 'Review', to: 'Build' })
    expect(ctx.lastStatus.get('PVTI_1')).toBe('Build')
  })

  it('emits nothing for a Status edit that did not change the value', async () => {
    const { outcome, emitted } = await runIntake(
      'projects_v2_item',
      itemPayload('edited', { field_name: 'Status', from: 'Build', to: 'Build' }),
      ctx,
    )
    expect(outcome).toBe('dispatched')
    expect(emitted).toEqual([])
  })

  it('emits issue.created when the card enters the board, and projects_v2_item.edited for other fields', async () => {
    expect(
      (await runIntake('projects_v2_item', itemPayload('created'), ctx)).emitted[0]?.type,
    ).toBe('issue.created')
    const { emitted } = await runIntake(
      'projects_v2_item',
      itemPayload('edited', { field_name: 'Task Type' }),
      ctx,
    )
    expect(emitted[0]).toMatchObject({
      type: 'projects_v2_item.edited',
      payload: { action: 'edited', fieldName: 'Task Type' },
    })
  })

  it('filters in the pipeline, before any read: other actions and non-issue items', async () => {
    for (const payload of [
      itemPayload('archived'),
      itemPayload('created', undefined, 'DraftIssue'),
    ]) {
      expect((await runIntake('projects_v2_item', payload, ctx)).outcome).toBe('skipped')
    }
    expect(ctx.reader.issueForItem).not.toHaveBeenCalled()
  })

  it('emits nothing for an item of a board that is not mounted', async () => {
    const other = fakeIntake({ board: { owner: 'la-haus', number: 1 } })
    expect((await runIntake('projects_v2_item', itemPayload('created'), other)).emitted).toEqual([])
  })
})

describe('intake: issue_comment', () => {
  it('emits the comment with the board status of its issue', async () => {
    const ctx = fakeIntake({ status: 'Refine', type: 'functional' })
    const { emitted } = await runIntake('issue_comment', commentPayload('falta paginar'), ctx)
    expect(emitted[0]).toMatchObject({
      type: 'issue_comment',
      scope: { projectId: 'lahaus-ai-flow' },
      payload: {
        action: 'created',
        body: 'falta paginar',
        author: 'julian',
        commentId: 555,
        item: { status: 'Refine', type: 'functional', labels: ['backend'] },
      },
    })
  })

  it('puts a comment made on a PR on the issue that PR implements', async () => {
    const ctx = fakeIntake()
    const { emitted } = await runIntake(
      'issue_comment',
      commentPayload('ok', { number: 12, pull_request: {} }),
      ctx,
    )
    expect(ctx.pullRequest).toHaveBeenCalledWith('la-haus', 'subscriptions', 12)
    expect(emitted[0]?.payload).toMatchObject({
      number: 7,
      prNumber: 12,
      task: { id: 'la-haus/subscriptions#7' },
    })
  })

  it('emits nothing for a repo the catalog does not declare', async () => {
    const payload = {
      ...commentPayload('hola'),
      repository: { name: 'otro', owner: { login: 'la-haus' } },
    }
    expect((await runIntake('issue_comment', payload, fakeIntake())).emitted).toEqual([])
  })
})

describe('intake: task context', () => {
  it('fills task.comments, task.ci and task.pr from the task context reader', async () => {
    const ctx = fakeIntake()
    const { emitted } = await runIntake(
      'pull_request_review',
      reviewPayload('CHANGES_REQUESTED'),
      ctx,
    )
    expect(ctx.taskContext.load).toHaveBeenCalledWith({
      owner: 'la-haus',
      repo: 'subscriptions',
      number: 7,
      pr: 12,
      branch: 'ia-flow/7',
    })
    expect(emitted[0]?.payload).toMatchObject({
      task: {
        comments: '[2026-09-25 10:00 · issue · julian]\nfalta paginar',
        ci: 'success',
        pr: { number: 12, url: 'https://github.com/la-haus/subscriptions/pull/12' },
      },
    })
  })
})

describe('intake: pull requests and CI', () => {
  it('flattens a review the way pr-changes-requested reads it', async () => {
    const { emitted } = await runIntake(
      'pull_request_review',
      reviewPayload('CHANGES_REQUESTED'),
      fakeIntake(),
    )
    expect(emitted[0]).toMatchObject({
      type: 'pull_request_review',
      payload: { number: 7, state: 'changes_requested', reviewer: 'rev', pr: { number: 12 } },
    })
  })

  it('keeps pr.merged on a closed pull_request', async () => {
    const payload = {
      action: 'closed',
      pull_request: { number: 12, merged: true, head: { ref: 'ia-flow/7' }, base: { ref: 'main' } },
      repository,
    }
    const { emitted } = await runIntake('pull_request', payload, fakeIntake())
    expect(emitted[0]?.payload).toMatchObject({
      action: 'closed',
      pr: { number: 12, merged: true },
    })
  })

  it('only lets completed CI runs through, and needs a PR or an ia-flow branch', async () => {
    const ctx = fakeIntake()
    expect(
      (await runIntake('workflow_run', runPayload('in_progress', [{ number: 12 }]), ctx)).outcome,
    ).toBe('skipped')
    expect((await runIntake('workflow_run', runPayload('completed', []), ctx)).emitted).toEqual([])

    const { emitted } = await runIntake(
      'workflow_run',
      runPayload('completed', [{ number: 12 }]),
      ctx,
    )
    expect(emitted[0]).toMatchObject({
      type: 'workflow_run',
      payload: { action: 'completed', conclusion: 'failure', prNumber: 12, kind: 'workflow_run' },
    })
  })
})

describe('intake: cards of another board (another engine)', () => {
  // El issue existe y el repo es del proyecto, pero la card no está en el board de ESTE runner
  // (vive en el de producción): el runner no lo toca, sea cual sea el evento.
  const offBoard = () =>
    fakeIntake(
      {},
      { reader: { itemForIssue: vi.fn(async () => undefined), issueForItem: vi.fn() } },
    )

  it('ignores comments, reviews and CI runs of an issue that is not on its board', async () => {
    for (const [event, payload] of [
      ['issue_comment', commentPayload('falta paginar')],
      ['pull_request_review', reviewPayload('CHANGES_REQUESTED')],
      ['workflow_run', runPayload('completed', [{ number: 12 }], 'ia-flow/7')],
    ] as const) {
      expect((await runIntake(event, payload, offBoard())).emitted, event).toEqual([])
    }
  })
})

describe('intake: the rest', () => {
  it('has no intake for events no rule needs', async () => {
    expect((await runIntake('issues', { action: 'opened' }, fakeIntake())).outcome).toBe('skipped')
    expect((await runIntake('push', {}, fakeIntake())).outcome).toBe('skipped')
  })
})

describe('linkedIssue', () => {
  it('reads the branch with the project prefix, and nothing else', () => {
    expect(linkedIssue('ia-flow-local/42', '', 'ia-flow-local/')).toBe(42)
    expect(linkedIssue('ia-flow/42', '', 'ia-flow-local/')).toBeUndefined()
    expect(linkedIssue('ia-flow/42', 'Closes #9', 'ia-flow-local/')).toBe(9)
  })

  it('prefers the ia-flow/<n> branch, then a closing reference', () => {
    expect(linkedIssue('ia-flow/42', 'Closes #9')).toBe(42)
    expect(linkedIssue('feat/x', 'Implements it.\n\nCloses #9')).toBe(9)
    expect(linkedIssue('feat/x', 'fixes #3')).toBe(3)
    expect(linkedIssue('ia-flow/42-extra', 'mentions #9')).toBeUndefined()
  })
})
