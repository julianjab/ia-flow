/**
 * El intake de `.config/` (`sources.pipelines` de runner.yaml) de punta a punta: un delivery CRUDO entra
 * como `github.<evento>`, `resolve_task` encuentra su task, la lee de GitHub (simulada) y publica
 * el evento de la task.
 */
import { describe, expect, it } from 'bun:test'
import {
  commentPayload,
  type FakeGithubData,
  fakeGithub,
  itemPayload,
  mountWith,
  repository,
  reviewPayload,
  runIntake,
  runPayload,
} from './fixtures.js'
import { configCopy } from './helpers.js'

const TASK = 'la-haus/subscriptions#7'

/** El runner con esta GitHub; `run` despacha un delivery crudo y devuelve lo que emitió. */
async function intake(data: FakeGithubData = {}) {
  const github = fakeGithub({
    items: { PVTI_1: TASK },
    ...data,
    tasks: { [TASK]: { status: 'Build', type: 'Technical', labels: ['blocked'] }, ...data.tasks },
  })
  const mounted = await mountWith(github)
  return {
    github,
    run: async (event: string, payload: Record<string, unknown>) => {
      try {
        return await runIntake(mounted, event, payload)
      } finally {
        mounted.stop()
      }
    },
  }
}

describe('intake: projects_v2_item', () => {
  it('emits issue.status_changed with from/to, scoped to the task', async () => {
    const { emitted } = await (await intake()).run(
      'projects_v2_item',
      itemPayload('edited', {
        field_name: 'Status',
        from: { name: 'Refined' },
        to: { name: 'Build' },
      }),
    )
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({
      type: 'issue.status_changed',
      scope: { projectId: 'lahaus-ai-flow', repo: 'la-haus/subscriptions', issue: TASK },
      payload: {
        from: 'Refined',
        to: 'Build',
        task_type: 'technical',
        item: { status: 'Build', type: 'technical', repos: ['subscriptions'], blocked: false },
        task: { id: TASK, branch: 'ia-flow-local/7', title: `Task ${TASK}` },
      },
    })
    expect(
      (emitted[0]?.payload as { project?: { repos: string } } | undefined)?.project?.repos,
    ).toContain('(la-haus/subscriptions)')
  })

  it("says who moved the card (sender): the echo of the runner's own change does not interrupt", async () => {
    const { emitted } = await (await intake()).run('projects_v2_item', {
      ...itemPayload('edited', {
        field_name: 'Status',
        from: { name: 'Build' },
        to: { name: 'Refine' },
      }),
      sender: { login: 'julian' },
    })
    expect(emitted[0]?.payload).toMatchObject({ from: 'Build', to: 'Refine', sender: 'julian' })
  })

  it('without from/to, to is the status the card has now', async () => {
    const { emitted } = await (await intake()).run(
      'projects_v2_item',
      itemPayload('edited', { field_name: 'Status' }),
    )
    expect(emitted[0]?.payload).toMatchObject({ to: 'Build', item: { status: 'Build' } })
  })

  it('emits nothing for a Status edit that did not change the value', async () => {
    const { outcome, emitted } = await (await intake()).run(
      'projects_v2_item',
      itemPayload('edited', {
        field_name: 'Status',
        from: { name: 'Build' },
        to: { name: 'Build' },
      }),
    )
    expect(outcome).toBe('dispatched')
    expect(emitted).toEqual([])
  })

  it('emits issue.created when the card enters the board, and projects_v2_item.edited for other fields', async () => {
    expect(
      (await (await intake()).run('projects_v2_item', itemPayload('created'))).emitted[0]?.type,
    ).toBe('issue.created')
    const { emitted } = await (await intake()).run(
      'projects_v2_item',
      itemPayload('edited', { field_name: 'Task Type' }),
    )
    expect(emitted[0]).toMatchObject({
      type: 'projects_v2_item.edited',
      payload: { action: 'edited', fieldName: 'Task Type' },
    })
  })

  it('filters before any read: other actions and non-issue items', async () => {
    for (const payload of [
      itemPayload('archived'),
      itemPayload('created', undefined, 'DraftIssue'),
    ]) {
      const { github, run } = await intake()
      expect((await run('projects_v2_item', payload)).emitted).toEqual([])
      expect(github.calls).toEqual([])
    }
  })

  it('emits nothing for an item of a board that is not this runner’s', async () => {
    const { github, run } = await intake({
      tasks: { [TASK]: { status: 'Build', board: { owner: 'la-haus', number: 1 } } },
    })
    expect((await run('projects_v2_item', itemPayload('created'))).emitted).toEqual([])
    expect(github.calls).toEqual(['graphql node'])
  })
})

describe('intake: issue_comment', () => {
  it('emits the comment with the board status of its issue', async () => {
    const { emitted } = await (
      await intake({
        tasks: { [TASK]: { status: 'Refine', type: 'Functional', labels: ['blocked', 'backend'] } },
      })
    ).run('issue_comment', commentPayload('falta paginar'))
    expect(emitted[0]).toMatchObject({
      type: 'issue_comment',
      scope: { projectId: 'lahaus-ai-flow', issue: TASK },
      payload: {
        action: 'created',
        body: 'falta paginar',
        author: 'julian',
        commentId: 555,
        item: { status: 'Refine', type: 'functional', labels: ['blocked', 'backend'] },
      },
    })
  })

  it('puts a comment made on a PR on the issue that PR implements', async () => {
    const { github, run } = await intake({
      prs: {
        'la-haus/subscriptions#12': { number: 12, head: { ref: 'ia-flow-local/7', sha: 's' } },
      },
    })
    const { emitted } = await run(
      'issue_comment',
      commentPayload('ok', { number: 12, pull_request: {} }),
    )
    expect(github.calls).toContain('GET /repos/la-haus/subscriptions/pulls/12')
    expect(emitted[0]?.payload).toMatchObject({
      number: 7,
      prNumber: 12,
      task: { id: TASK, pr: { number: 12 } },
    })
  })

  it('emits nothing for a repo the catalog does not declare, without reading GitHub', async () => {
    const payload = {
      ...commentPayload('hola'),
      repository: { name: 'otro', full_name: 'la-haus/otro', owner: { login: 'la-haus' } },
    }
    const { github, run } = await intake()
    expect((await run('issue_comment', payload)).emitted).toEqual([])
    expect(github.calls).toEqual([])
  })
})

describe('intake: task context', () => {
  it('fills task.comments, task.ci, task.pr and task.blockers from GitHub', async () => {
    const { emitted } = await (
      await intake({
        tasks: {
          [TASK]: {
            status: 'Review',
            labels: ['blocked'],
            comments: [
              {
                body: 'falta paginar',
                created_at: '2026-09-25T10:00:00Z',
                user: { login: 'julian' },
              },
            ],
            blockedBy: [
              {
                number: 3,
                title: 'migrar tabla',
                state: 'open',
                html_url: 'https://github.com/x/3',
              },
              { number: 2, title: 'ya hecho', state: 'closed', html_url: 'https://github.com/x/2' },
            ],
          },
        },
        prs: {
          'la-haus/subscriptions#12': { number: 12, head: { ref: 'ia-flow-local/7', sha: 'abc' } },
        },
        checks: [{ status: 'completed', conclusion: 'failure' }],
      })
    ).run('pull_request_review', reviewPayload('changes_requested'))
    expect(emitted[0]?.payload).toMatchObject({
      item: { blocked: true },
      task: {
        ci: 'failure',
        pr: { number: 12, url: 'https://github.com/la-haus/subscriptions/pull/12' },
        blockers: '#3 migrar tabla (https://github.com/x/3)',
      },
    })
    expect(
      (emitted[0]?.payload as { task?: { comments: string } } | undefined)?.task?.comments,
    ).toContain('· issue · julian]\nfalta paginar')
  })
})

describe('intake: task.ci counts the whole CI of the commit', () => {
  it('a workflow still queued (its jobs not created yet) keeps task.ci pending', async () => {
    const { emitted } = await (
      await intake({
        tasks: { [TASK]: { status: 'Review' } },
        prs: {
          'la-haus/subscriptions#12': { number: 12, head: { ref: 'ia-flow-local/7', sha: 'abc' } },
        },
        // El workflow rápido (validar el título) ya terminó; el CI de verdad sigue en cola.
        checks: [{ status: 'completed', conclusion: 'success' }],
        workflowRuns: [{ status: 'completed' }, { status: 'queued' }],
      })
    ).run('pull_request_review', reviewPayload('changes_requested'))
    expect(emitted[0]?.payload).toMatchObject({ task: { ci: 'pending' } })
  })
})

describe('intake: the task PR comes from GitHub, not from a branch name', () => {
  it('a card reaching Review gets task.pr from the PR linked to its issue, on any branch', async () => {
    const { emitted } = await (
      await intake({
        tasks: { [TASK]: { status: 'Review' } },
        prs: {
          'la-haus/subscriptions#1679': {
            number: 1679,
            closes: 7,
            head: { ref: 'feat/auth0-strategy-crm-admin-registration', sha: 'abc' },
          },
        },
      })
    ).run(
      'projects_v2_item',
      itemPayload('edited', {
        field_name: 'Status',
        from: { name: 'Build' },
        to: { name: 'Review' },
      }),
    )
    expect(emitted[0]).toMatchObject({
      type: 'issue.status_changed',
      payload: {
        to: 'Review',
        task: { pr: { number: 1679, headRef: 'feat/auth0-strategy-crm-admin-registration' } },
      },
    })
  })

  it('a PR that is not linked to the issue is not its PR, even on a `ia-flow-local/<n>` branch', async () => {
    const { emitted } = await (
      await intake({
        tasks: { [TASK]: { status: 'Review' } },
        prs: {
          'la-haus/subscriptions#12': {
            number: 12,
            closes: null,
            head: { ref: 'ia-flow-local/7', sha: 's' },
          },
        },
      })
    ).run(
      'projects_v2_item',
      itemPayload('edited', {
        field_name: 'Status',
        from: { name: 'Build' },
        to: { name: 'Review' },
      }),
    )
    expect(emitted).toHaveLength(1)
    const payload = emitted[0]?.payload as { task?: { pr?: unknown } } | undefined
    expect(payload?.task?.pr).toBeUndefined()
  })
})

describe('intake: pull requests and CI', () => {
  it('flattens a review the way pr-changes-requested reads it', async () => {
    const { emitted } = await (await intake()).run(
      'pull_request_review',
      reviewPayload('changes_requested'),
    )
    expect(emitted[0]).toMatchObject({
      type: 'pull_request_review',
      payload: { number: 7, state: 'changes_requested', reviewer: 'rev', pr: { number: 12 } },
    })
  })

  it('keeps pr.merged on a closed pull_request', async () => {
    const payload = {
      action: 'closed',
      pull_request: {
        number: 12,
        merged: true,
        head: { ref: 'ia-flow-local/7' },
        base: { ref: 'main' },
      },
      repository,
    }
    const { emitted } = await (await intake()).run('pull_request', payload)
    expect(emitted.find((e) => e.type === 'pull_request')?.payload).toMatchObject({
      action: 'closed',
      pr: { number: 12, merged: true },
    })
  })

  it('only lets completed CI runs through, and needs a PR', async () => {
    const inProgress = await intake()
    expect(
      (await inProgress.run('workflow_run', runPayload('in_progress', [{ number: 12 }]))).emitted,
    ).toEqual([])
    expect(inProgress.github.calls).toEqual([])
    // Sin PR no hay relación que leer, aunque la rama parezca de una task.
    expect(
      (await (await intake()).run('workflow_run', runPayload('completed', [], 'ia-flow-local/7')))
        .emitted,
    ).toEqual([])

    const { emitted } = await (await intake()).run(
      'workflow_run',
      runPayload('completed', [{ number: 12 }]),
    )
    expect(emitted[0]).toMatchObject({
      type: 'workflow_run',
      payload: { number: 7, action: 'completed', conclusion: 'failure', kind: 'workflow_run' },
    })
  })
})

describe('intake: a PR that closes no issue is not a task', () => {
  // Su número no resuelve como `Issue` en GraphQL: usarlo de task rompía el despacho con
  // `Could not resolve to an Issue with the number of N`.
  const closesNothing = {
    prs: {
      'la-haus/subscriptions#12': { number: 12, closes: null, head: { ref: 'feat/x', sha: 's' } },
    },
  }
  /** Lo único que se lee es qué cierra el PR: nada de la task. */
  const onlyClosingRefs = (calls: string[]) =>
    calls.filter((call) => !call.includes('closingIssuesReferences'))
  const prPayload = {
    number: 12,
    body: 'Closes #7',
    head: { ref: 'ia-flow-local/7', sha: 's' },
    base: { ref: 'main' },
  }

  it('skips a CI run whose PR closes no issue', async () => {
    const { github, run } = await intake(closesNothing)
    const { emitted } = await run('workflow_run', runPayload('completed', [{ number: 12 }]))
    expect(emitted).toEqual([])
    expect(onlyClosingRefs(github.calls)).toEqual([])
  })

  it('finds the issue of a CI run by what GitHub says the PR closes, whatever its branch', async () => {
    const { emitted } = await (
      await intake({
        prs: {
          'la-haus/subscriptions#12': { number: 12, closes: 7, head: { ref: 'feat/x', sha: 's' } },
        },
      })
    ).run('workflow_run', runPayload('completed', [{ number: 12 }]))
    expect(emitted[0]).toMatchObject({
      type: 'workflow_run',
      payload: { number: 7, prNumber: 12, kind: 'workflow_run' },
    })
  })

  it('ignores the branch name and the body: only what GitHub links counts', async () => {
    for (const [event, payload] of [
      ['pull_request', { action: 'opened', pull_request: prPayload, repository }],
      ['pull_request_review', { ...reviewPayload('approved'), pull_request: prPayload }],
    ] as const) {
      const { github, run } = await intake(closesNothing)
      expect((await run(event, payload)).emitted, event).toEqual([])
      expect(onlyClosingRefs(github.calls), event).toEqual([])
    }
  })

  it('skips a comment on a PR that closes no issue', async () => {
    const { github, run } = await intake(closesNothing)
    const { emitted } = await run(
      'issue_comment',
      commentPayload('ok', { number: 12, pull_request: {} }),
    )
    expect(emitted).toEqual([])
    expect(onlyClosingRefs(github.calls).filter((c) => c.startsWith('graphql'))).toEqual([])
  })
})

describe('intake: cards of another board (another engine)', () => {
  // El issue existe y el repo es del proyecto, pero la card no está en el board de ESTE runner
  // (vive en el de producción): el runner no lo toca, sea cual sea el evento.
  it('ignores comments, reviews and CI runs of an issue that is not on its board', async () => {
    for (const [event, payload] of [
      ['issue_comment', commentPayload('falta paginar')],
      ['pull_request_review', reviewPayload('changes_requested')],
      ['workflow_run', runPayload('completed', [{ number: 12 }], 'ia-flow-local/7')],
    ] as const) {
      const { github, run } = await intake({ tasks: { [TASK]: { status: 'Build', board: null } } })
      expect((await run(event, payload)).emitted, event).toEqual([])
      // Sin card no se lee nada más de la task.
      expect(
        github.calls.filter((call) => call.includes('/issues/7')),
        event,
      ).toEqual([])
    }
  })
})

describe('intake: cards without the project label (another engine)', () => {
  // `runner.yaml` → `label: blocked`: el engine de producción toma las cards SIN esa label.
  it('publishes nothing for a card of this board without the label', async () => {
    for (const [event, payload] of [
      ['issue_comment', commentPayload('falta paginar')],
      ['projects_v2_item', itemPayload('created')],
      ['workflow_run', runPayload('completed', [], 'ia-flow-local/7')],
    ] as const) {
      const { run } = await intake({ tasks: { [TASK]: { status: 'Build', labels: ['backend'] } } })
      expect((await run(event, payload)).emitted, event).toEqual([])
    }
  })
})

describe('intake: the rest', () => {
  it('has no intake for events no pipeline needs', async () => {
    expect((await (await intake()).run('issues', { action: 'opened' })).outcome).toBe('skipped')
    expect((await (await intake()).run('push', {})).outcome).toBe('skipped')
  })
})

describe('intake: several projects', () => {
  /** `.config` con un segundo proyecto, inline en runner.yaml (`sources.projects`): `otro`, sobre el board 120 y el
   *  mismo catálogo de repos. */
  function twoProjects(): string {
    return configCopy({
      'runner.yaml': (content) =>
        `${content}    otro:\n      board: https://github.com/orgs/la-haus/projects/120\n      branchPrefix: otro/\n      label: blocked\n      repos: ./projects/lahaus-ai-flow/repos\n`,
    })
  }

  it('publishes to the project whose board has the card, with its branch prefix and message', async () => {
    const github = fakeGithub({
      items: { PVTI_1: TASK },
      tasks: {
        [TASK]: {
          status: 'Build',
          labels: ['blocked'],
          board: { owner: 'la-haus', number: 120 },
        },
      },
    })
    const mounted = await mountWith(github, undefined, twoProjects())
    try {
      const { emitted } = await runIntake(mounted, 'issue_comment', commentPayload('ojo con esto'))
      expect(emitted.map((event) => event.scope?.projectId)).toEqual(['otro'])
      expect(emitted[0]?.payload).toMatchObject({
        task: { branch: 'otro/7' },
        message: expect.stringContaining('ojo con esto'),
      })
    } finally {
      mounted.stop()
    }
  })
})

describe('intake: the task branch without branchPrefix (as ia-flow)', () => {
  /** El proyecto sin `branchPrefix`, con esta GitHub. */
  async function withoutPrefix(task: Record<string, unknown> = {}) {
    const github = fakeGithub({
      items: { PVTI_1: TASK },
      tasks: { [TASK]: { status: 'Build', type: 'Technical', labels: ['blocked'], ...task } },
    })
    const dir = configCopy({
      'projects/lahaus-ai-flow/project.yaml': (s) => s.replace(/^branchPrefix: .*$/m, ''),
    })
    const mounted = await mountWith(github, undefined, dir)
    try {
      const { emitted } = await runIntake(
        mounted,
        'projects_v2_item',
        itemPayload('edited', {
          field_name: 'Status',
          from: { name: 'Refined' },
          to: { name: 'Build' },
        }),
      )
      return (emitted[0]?.payload as { task?: { branch?: string } } | undefined)?.task?.branch
    } finally {
      mounted.stop()
    }
  }

  it('is the branch already linked to the issue', async () => {
    expect(await withoutPrefix({ linkedBranches: ['feat/paginar-leads'] })).toBe(
      'feat/paginar-leads',
    )
  })

  it('without a linked branch nor the branchName capability, it is task/<n>', async () => {
    expect(await withoutPrefix()).toBe('task/7')
  })
})
