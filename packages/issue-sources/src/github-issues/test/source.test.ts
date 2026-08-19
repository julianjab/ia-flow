import { describe, expect, test } from 'bun:test'
import type { GitHubIssuesApi, RestIssue } from '../api/issues-client.js'
import { GitHubIssueSource } from '../source.js'
import { StatusLabelCodec, WORKING_LABEL } from '../status-label.js'
import { GitHubIssueTaskSource } from '../task-source.js'

// Dependency injection means the source/task-source can be tested against a
// fake GitHubIssuesApi instead of mocking `fetch` — that's the whole point
// of wrapping the REST calls in a class rather than free functions.
function fakeApi(overrides: Partial<GitHubIssuesApi> = {}): GitHubIssuesApi {
  return {
    listByLabel: async () => [],
    getByNumber: async () => null,
    listRepoLabels: async () => [],
    replaceLabels: async () => {},
    create: async () => {
      throw new Error('not stubbed')
    },
    addComment: async () => {},
    listComments: async () => [],
    updateBody: async () => {},
    getBlockers: async () => [],
    addBlockedBy: async () => {},
    getLinkedBranch: async () => null,
    ...overrides,
  } as GitHubIssuesApi
}

const CONFIG = { owner: 'la-haus', repo: 'ia-flow', anchorLabel: 'ia-flow' }

function issue(overrides: Partial<RestIssue> = {}): RestIssue {
  return {
    id: 'ISSUE_1',
    number: 42,
    title: 'Do the thing',
    body: 'Body text',
    state: 'open',
    labels: ['ia-flow', 'status:refine'],
    assignees: [],
    url: 'https://github.com/la-haus/ia-flow/issues/42',
    ...overrides,
  }
}

describe('GitHubIssueSource.getItems', () => {
  test('lists issues filtered by the anchor label and maps status from the status: label', async () => {
    const api = fakeApi({ listByLabel: async () => [issue()] })
    const source = new GitHubIssueSource(CONFIG, api)
    const items = await source.getItems()
    expect(items).toHaveLength(1)
    expect(items[0].status).toBe('refine')
    expect(items[0].id).toBe('ISSUE_1')
  })

  test('opts.status narrows to matching items case-insensitively', async () => {
    const api = fakeApi({
      listByLabel: async () => [
        issue({ id: 'A', labels: ['ia-flow', 'status:refine'] }),
        issue({ id: 'B', labels: ['ia-flow', 'status:done'] }),
      ],
    })
    const source = new GitHubIssueSource(CONFIG, api)
    const items = await source.getItems({ status: 'REFINE' })
    expect(items.map((i) => i.id)).toEqual(['A'])
  })
})

describe('GitHubIssueSource.getStatuses', () => {
  test('derives statuses from the repo label catalog', async () => {
    const api = fakeApi({
      listRepoLabels: async () => ['bug', 'status:refine', 'status:done', 'ia-flow'],
    })
    const source = new GitHubIssueSource(CONFIG, api)
    const statuses = await source.getStatuses()
    expect(statuses).toEqual([{ name: 'refine' }, { name: 'done' }])
  })

  test('honors a custom StatusLabelCodec prefix instead of a hardcoded status:', async () => {
    const api = fakeApi({
      listRepoLabels: async () => ['bug', 'pipeline/refine', 'pipeline/done'],
    })
    const source = new GitHubIssueSource(CONFIG, api, new StatusLabelCodec('pipeline/'))
    const statuses = await source.getStatuses()
    expect(statuses).toEqual([{ name: 'refine' }, { name: 'done' }])
  })
})

describe('GitHubIssueSource.toIssueItem', () => {
  test('strips prior AI history after the "---" separator', async () => {
    const api = fakeApi({
      listByLabel: async () => [issue({ body: 'Human text\n\n---\n\nAI notes' })],
    })
    const source = new GitHubIssueSource(CONFIG, api)
    const [raw] = await source.getItems()
    const item = source.toIssueItem(raw)
    expect(item.description).toBe('Human text')
    expect(item.repos).toEqual(['ia-flow'])
  })
})

describe('GitHubIssueSource.matchesWebhook', () => {
  test('matches the configured owner/repo, case-insensitively', async () => {
    const source = new GitHubIssueSource(CONFIG, fakeApi())
    expect(await source.matchesWebhook({ repoFullName: 'La-Haus/IA-Flow' })).toBe(true)
    expect(await source.matchesWebhook({ repoFullName: 'other/repo' })).toBe(false)
  })

  test('matches everything when the hint carries no repo (safer default)', async () => {
    const source = new GitHubIssueSource(CONFIG, fakeApi())
    expect(await source.matchesWebhook({})).toBe(true)
  })
})

describe('GitHubIssueSource.getHealth', () => {
  test('ok when config is complete', async () => {
    const source = new GitHubIssueSource(CONFIG, fakeApi())
    expect((await source.getHealth()).ok).toBe(true)
  })

  test('reports missing fields when config is incomplete', async () => {
    const source = new GitHubIssueSource({ owner: '', repo: 'ia-flow', anchorLabel: '' }, fakeApi())
    const health = await source.getHealth()
    expect(health.ok).toBe(false)
    expect(health.missing.map((f) => f.name)).toEqual(['owner', 'anchorLabel'])
  })
})

describe('GitHubIssueTaskSource.applyTransition', () => {
  test('replaces the status label while keeping the rest, and broadcasts', async () => {
    const calls: unknown[] = []
    const api = fakeApi({
      replaceLabels: async (_o, _r, _n, labels) => {
        calls.push(labels)
      },
    })
    const source = new GitHubIssueSource(CONFIG, api)
    const item = source.toIssueItem({
      id: 'ISSUE_1',
      title: 'x',
      status: 'refine',
      meta: { issueId: 'ISSUE_1', issueNumber: 42, labels: ['ia-flow', 'status:refine', 'bug'] },
    })
    const events: unknown[] = []
    const taskSource = new GitHubIssueTaskSource(CONFIG, api, new StatusLabelCodec(), item, (msg) =>
      events.push(msg),
    )
    const task = {
      id: 'ISSUE_1',
      title: 'x',
      description: '',
      status: 'refine',
      type: 'functional' as const,
      repos: ['ia-flow'],
      created_at: '',
    }
    const updated = await taskSource.applyTransition(task, 'done')
    expect(calls).toEqual([['ia-flow', 'bug', 'status:done']])
    expect(updated.status).toBe('done')
    expect(events).toHaveLength(1)
  })
})

describe('GitHubIssueTaskSource.setAgentWorking', () => {
  test('adds and removes the working label', async () => {
    const calls: string[][] = []
    const api = fakeApi({
      replaceLabels: async (_o, _r, _n, labels) => {
        calls.push(labels)
      },
    })
    const source = new GitHubIssueSource(CONFIG, api)
    const item = source.toIssueItem({
      id: 'ISSUE_1',
      title: 'x',
      status: 'refine',
      meta: { issueId: 'ISSUE_1', issueNumber: 42, labels: ['ia-flow'] },
    })
    const taskSource = new GitHubIssueTaskSource(
      CONFIG,
      api,
      new StatusLabelCodec(),
      item,
      () => {},
    )
    const task = {
      id: 'ISSUE_1',
      title: 'x',
      description: '',
      status: 'refine',
      type: 'functional' as const,
      repos: ['ia-flow'],
      created_at: '',
    }
    await taskSource.setAgentWorking(task, true)
    await taskSource.setAgentWorking(task, false)
    expect(calls).toEqual([['ia-flow', WORKING_LABEL], ['ia-flow']])
  })
})

describe('GitHubIssueTaskSource.postError', () => {
  test('posts a formatted error comment', async () => {
    const bodies: string[] = []
    const api = fakeApi({
      addComment: async (_id, body) => {
        bodies.push(body)
      },
    })
    const source = new GitHubIssueSource(CONFIG, api)
    const item = source.toIssueItem({
      id: 'ISSUE_1',
      title: 'x',
      status: 'refine',
      meta: { issueId: 'ISSUE_1', issueNumber: 42, labels: [] },
    })
    const taskSource = new GitHubIssueTaskSource(
      CONFIG,
      api,
      new StatusLabelCodec(),
      item,
      () => {},
    )
    await taskSource.postError(
      {
        id: 'ISSUE_1',
        title: 'x',
        description: '',
        status: 'refine',
        type: 'functional',
        repos: [],
        created_at: '',
      },
      'boom',
    )
    expect(bodies[0]).toContain('boom')
    expect(bodies[0]).toContain('Agent error')
  })
})

describe('GitHubIssueTaskSource.setLabels', () => {
  test('re-adds the anchor label and current status label even if the caller omits them', async () => {
    const calls: string[][] = []
    const api = fakeApi({
      getByNumber: async () => issue({ labels: ['ia-flow', 'status:refine', 'bug'] }),
      replaceLabels: async (_o, _r, _n, labels) => {
        calls.push(labels)
      },
    })
    const source = new GitHubIssueSource(CONFIG, api)
    const item = source.toIssueItem({
      id: 'ISSUE_1',
      title: 'x',
      status: 'refine',
      meta: { issueId: 'ISSUE_1', issueNumber: 42, labels: ['ia-flow', 'status:refine', 'bug'] },
    })
    const taskSource = new GitHubIssueTaskSource(
      CONFIG,
      api,
      new StatusLabelCodec(),
      item,
      () => {},
    )
    const task = {
      id: 'ISSUE_1',
      title: 'x',
      description: '',
      status: 'refine',
      type: 'functional' as const,
      repos: ['ia-flow'],
      created_at: '',
    }
    // Simulates `$labels:=deployed` — the caller's desired set doesn't
    // mention the anchor or status label at all.
    await taskSource.setLabels(task, ['deployed'])
    expect(calls[0]).toContain('ia-flow')
    expect(calls[0]).toContain('status:refine')
    expect(calls[0]).toContain('deployed')
  })

  test('does not duplicate the status label when the caller already includes it', async () => {
    const calls: string[][] = []
    const api = fakeApi({
      getByNumber: async () => issue({ labels: ['ia-flow', 'status:refine'] }),
      replaceLabels: async (_o, _r, _n, labels) => {
        calls.push(labels)
      },
    })
    const source = new GitHubIssueSource(CONFIG, api)
    const item = source.toIssueItem({
      id: 'ISSUE_1',
      title: 'x',
      status: 'refine',
      meta: { issueId: 'ISSUE_1', issueNumber: 42, labels: ['ia-flow', 'status:refine'] },
    })
    const taskSource = new GitHubIssueTaskSource(
      CONFIG,
      api,
      new StatusLabelCodec(),
      item,
      () => {},
    )
    const task = {
      id: 'ISSUE_1',
      title: 'x',
      description: '',
      status: 'refine',
      type: 'functional' as const,
      repos: ['ia-flow'],
      created_at: '',
    }
    await taskSource.setLabels(task, ['ia-flow', 'status:done'])
    expect(calls[0].filter((l) => l.startsWith('status:'))).toEqual(['status:done'])
  })

  test('re-adds WORKING_LABEL if the issue is mid-run and the caller omits it', async () => {
    const calls: string[][] = []
    const api = fakeApi({
      getByNumber: async () => issue({ labels: ['ia-flow', 'status:refine', WORKING_LABEL] }),
      replaceLabels: async (_o, _r, _n, labels) => {
        calls.push(labels)
      },
    })
    const source = new GitHubIssueSource(CONFIG, api)
    const item = source.toIssueItem({
      id: 'ISSUE_1',
      title: 'x',
      status: 'refine',
      meta: {
        issueId: 'ISSUE_1',
        issueNumber: 42,
        labels: ['ia-flow', 'status:refine', WORKING_LABEL],
      },
    })
    const taskSource = new GitHubIssueTaskSource(
      CONFIG,
      api,
      new StatusLabelCodec(),
      item,
      () => {},
    )
    const task = {
      id: 'ISSUE_1',
      title: 'x',
      description: '',
      status: 'refine',
      type: 'functional' as const,
      repos: ['ia-flow'],
      created_at: '',
    }
    // Simulates the agent itself calling `$labels:=reviewed` mid-run —
    // dropping WORKING_LABEL here would make the next runCycle re-dispatch.
    await taskSource.setLabels(task, ['reviewed'])
    expect(calls[0]).toContain(WORKING_LABEL)
  })
})

describe('GitHubIssueTaskSource.setFields', () => {
  const task = {
    id: 'ISSUE_1',
    title: 'x',
    description: '',
    status: 'refine',
    type: 'functional' as const,
    repos: ['ia-flow'],
    created_at: '',
  }

  function build(api: GitHubIssuesApi) {
    const source = new GitHubIssueSource(CONFIG, api)
    const item = source.toIssueItem({
      id: 'ISSUE_1',
      title: 'x',
      status: 'refine',
      meta: { issueId: 'ISSUE_1', issueNumber: 42, labels: ['ia-flow', 'status:refine'] },
    })
    return new GitHubIssueTaskSource(CONFIG, api, new StatusLabelCodec(), item, () => {})
  }

  test('is defined — set_task_field must not throw for this source (LSP: no special-casing at the caller)', () => {
    const taskSource = build(fakeApi())
    expect(typeof taskSource.setFields).toBe('function')
  })

  test('routes a "Status" field through the same label transition as applyTransition', async () => {
    const calls: string[][] = []
    const taskSource = build(
      fakeApi({
        getByNumber: async () => issue({ labels: ['ia-flow', 'status:refine'] }),
        replaceLabels: async (_o, _r, _n, labels) => {
          calls.push(labels)
        },
      }),
    )
    const updated = await taskSource.setFields(task, { Status: 'done' })
    expect(calls[0]).toContain('status:done')
    expect(updated.status).toBe('done')
  })

  test('keeps a non-native field in-memory only (task.fields), without persisting to GitHub', async () => {
    const calls: unknown[] = []
    const taskSource = build(
      fakeApi({
        replaceLabels: async () => {
          calls.push('called')
        },
      }),
    )
    const updated = await taskSource.setFields(task, { Priority: 'high' })
    expect(calls).toHaveLength(0)
    expect(updated.fields?.Priority).toBe('high')
  })
})
