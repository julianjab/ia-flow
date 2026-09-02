import { describe, expect, test } from 'bun:test'
import type { IssueItem, SourceItem } from '../../contract.js'
import { deliverWebhook, triggerWebhookTarget } from '../../dispatch/webhook-registry.js'
import { extractSlackThreadUrl, upsertSlackSection } from '../../github-shared/slack-section.js'
import type { GitHubIssuesApi, RestIssue } from '../api/issues-client.js'
import { FieldLabelCodec } from '../field-label.js'
import { GitHubIssueSource } from '../source.js'
import { StatusLabelCodec, WORKING_LABEL } from '../status-label.js'
import { GitHubIssueTaskSource } from '../task-source.js'

// Dependency injection means the source/task-source can be tested against a
// fake GitHubIssuesApi instead of mocking `fetch` — that's the whole point
// of wrapping the REST calls in a class rather than free functions.
function fakeApi(overrides: Partial<GitHubIssuesApi> = {}): GitHubIssuesApi {
  return {
    listIssues: async () => [],
    getByNumber: async () => null,
    getById: async () => null,
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
    getDevLinks: async () => new Map(),
    ...overrides,
  } as GitHubIssuesApi
}

const CONFIG = { owner: 'la-haus', repo: 'ia-flow', anchorLabel: 'ia-flow' }
// Mismo repo, modo "sin ancla": todo issue abierto es candidato.
const ANCHORLESS_CONFIG = { owner: 'la-haus', repo: 'ia-flow' }

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
    const api = fakeApi({ listIssues: async () => [issue()] })
    const source = new GitHubIssueSource(CONFIG, api)
    const items = await source.getItems()
    expect(items).toHaveLength(1)
    expect(items[0].status).toBe('refine')
    expect(items[0].id).toBe('ISSUE_1')
  })

  test('opts.status narrows to matching items case-insensitively', async () => {
    const api = fakeApi({
      listIssues: async () => [
        issue({ id: 'A', labels: ['ia-flow', 'status:refine'] }),
        issue({ id: 'B', labels: ['ia-flow', 'status:done'] }),
      ],
    })
    const source = new GitHubIssueSource(CONFIG, api)
    const items = await source.getItems({ status: 'REFINE' })
    expect(items.map((i) => i.id)).toEqual(['A'])
  })
})

describe('GitHubIssueSource — dev links (branch + PRs)', () => {
  test('getItems() populates meta.linkedBranch/pullRequests, y toIssueItem expone la branch', async () => {
    const api = fakeApi({
      listIssues: async () => [issue()],
      getDevLinks: async (ids, repoName) => {
        expect(ids).toEqual(['ISSUE_1'])
        expect(repoName).toBe('ia-flow')
        return new Map([
          [
            'ISSUE_1',
            {
              branch: 'fix/existing-branch',
              pullRequests: [
                {
                  number: 7,
                  url: 'https://github.com/la-haus/ia-flow/pull/7',
                  state: 'open' as const,
                  isDraft: false,
                },
              ],
              pullRequestsKnown: true,
            },
          ],
        ])
      },
    })
    const source = new GitHubIssueSource(CONFIG, api)
    const [raw] = await source.getItems()
    expect(raw.meta?.linkedBranch).toBe('fix/existing-branch')
    expect(raw.meta?.pullRequests).toEqual([
      {
        number: 7,
        url: 'https://github.com/la-haus/ia-flow/pull/7',
        state: 'open',
        isDraft: false,
      },
    ])
    const item = source.toIssueItem(raw)
    expect(item.branch).toBe('fix/existing-branch')
  })

  test('un solo request de dev links para todos los issues del listado', async () => {
    let calls = 0
    const api = fakeApi({
      listIssues: async () => [issue({ id: 'A' }), issue({ id: 'B' }), issue({ id: 'C' })],
      getDevLinks: async (ids) => {
        calls++
        expect(ids).toEqual(['A', 'B', 'C'])
        return new Map()
      },
    })
    const source = new GitHubIssueSource(CONFIG, api)
    await source.getItems()
    expect(calls).toBe(1)
  })

  test('getItems() leaves branch undefined when the issue has no linked branch', async () => {
    const api = fakeApi({
      listIssues: async () => [issue()],
      getDevLinks: async () =>
        new Map([['ISSUE_1', { pullRequests: [], pullRequestsKnown: true }]]),
    })
    const source = new GitHubIssueSource(CONFIG, api)
    const [raw] = await source.getItems()
    expect(raw.meta?.linkedBranch).toBeUndefined()
    const item = source.toIssueItem(raw)
    expect(item.branch).toBeUndefined()
  })

  test('getItems() proceeds without dev links when getDevLinks rejects', async () => {
    const api = fakeApi({
      listIssues: async () => [issue()],
      getDevLinks: async () => {
        throw new Error('graphql down')
      },
    })
    const source = new GitHubIssueSource(CONFIG, api)
    const items = await source.getItems()
    expect(items).toHaveLength(1)
    expect(items[0].meta?.linkedBranch).toBeUndefined()
  })

  test('getItemById() also populates the linked branch', async () => {
    const api = fakeApi({
      getById: async (id) => (id === 'ISSUE_1' ? issue() : null),
      getDevLinks: async () =>
        new Map([
          ['ISSUE_1', { branch: 'fix/from-get-by-id', pullRequests: [], pullRequestsKnown: true }],
        ]),
    })
    const source = new GitHubIssueSource(CONFIG, api)
    const item = await source.getItemById('ISSUE_1')
    expect(item?.meta?.linkedBranch).toBe('fix/from-get-by-id')
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
      listIssues: async () => [issue({ body: 'Human text\n\n---\n\nAI notes' })],
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
    const source = new GitHubIssueSource({ owner: '', repo: '' }, fakeApi())
    const health = await source.getHealth()
    expect(health.ok).toBe(false)
    expect(health.missing.map((f) => f.name)).toEqual(['owner', 'repo'])
  })

  test('sin anchorLabel sigue ok, pero con warning', async () => {
    // El ancla es opcional: el source funciona vigilando el repo entero. Que
    // eso sea un warning y no un `missing` es la diferencia entre "config
    // incompleta" y "decisión deliberada que conviene ver en la UI".
    const source = new GitHubIssueSource(ANCHORLESS_CONFIG, fakeApi())
    const health = await source.getHealth()
    expect(health.ok).toBe(true)
    expect(health.missing).toEqual([])
    expect(health.warnings.map((f) => f.name)).toEqual(['anchorLabel'])
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
    const taskSource = new GitHubIssueTaskSource(
      CONFIG,
      api,
      new StatusLabelCodec(),
      new FieldLabelCodec(),
      item,
      (msg) => events.push(msg),
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
      new FieldLabelCodec(),
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
      new FieldLabelCodec(),
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

  test('skips the comment when the failure was already commented (fail_task)', async () => {
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
      new FieldLabelCodec(),
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
      { alreadyCommented: true },
    )
    expect(bodies).toHaveLength(0)
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
      new FieldLabelCodec(),
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
      new FieldLabelCodec(),
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
      new FieldLabelCodec(),
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

  test('re-adds a field:* label the caller omits, but not one it already replaced', async () => {
    const calls: string[][] = []
    const api = fakeApi({
      getByNumber: async () =>
        issue({ labels: ['ia-flow', 'status:refine', 'field:Priority=high', 'field:Size=M'] }),
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
        labels: ['ia-flow', 'status:refine', 'field:Priority=high', 'field:Size=M'],
      },
    })
    const taskSource = new GitHubIssueTaskSource(
      CONFIG,
      api,
      new StatusLabelCodec(),
      new FieldLabelCodec(),
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
    // Caller's set replaces Size but says nothing about Priority.
    await taskSource.setLabels(task, ['ia-flow', 'status:refine', 'field:Size=L'])
    expect(calls[0]).toContain('field:Priority=high')
    expect(calls[0]).toContain('field:Size=L')
    expect(calls[0]).not.toContain('field:Size=M')
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
    return new GitHubIssueTaskSource(
      CONFIG,
      api,
      new StatusLabelCodec(),
      new FieldLabelCodec(),
      item,
      () => {},
    )
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

  test('persists a non-native field as a field:<name>=<value> label', async () => {
    const calls: string[][] = []
    const taskSource = build(
      fakeApi({
        replaceLabels: async (_o, _r, _n, labels) => {
          calls.push(labels)
        },
      }),
    )
    const updated = await taskSource.setFields(task, { Priority: 'high' })
    expect(calls[0]).toContain('field:Priority=high')
    expect(updated.fields?.Priority).toBe('high')
  })

  test('replacing a field label leaves other labels (including other fields) untouched', async () => {
    const calls: string[][] = []
    const taskSource = build(
      fakeApi({
        getByNumber: async () =>
          issue({ labels: ['ia-flow', 'status:refine', 'field:Priority=low', 'field:Size=M'] }),
        replaceLabels: async (_o, _r, _n, labels) => {
          calls.push(labels)
        },
      }),
    )
    await taskSource.setFields(task, { Priority: 'high' })
    expect(calls[0]).toContain('field:Priority=high')
    expect(calls[0]).not.toContain('field:Priority=low')
    expect(calls[0]).toContain('field:Size=M')
    expect(calls[0]).toContain('status:refine')
  })
})

describe('GitHubIssueSource — field label round-trip', () => {
  test('getItems surfaces field:* labels as SourceItem.meta.fields', async () => {
    const api = fakeApi({
      listIssues: async () => [
        issue({ labels: ['ia-flow', 'status:refine', 'field:Priority=high'] }),
      ],
    })
    const source = new GitHubIssueSource(CONFIG, api)
    const [item] = await source.getItems()
    expect(item.meta?.fields).toEqual({ Priority: 'high' })
  })

  test('toIssueItem exposes the same fields under task.fields', async () => {
    const api = fakeApi({
      listIssues: async () => [
        issue({ labels: ['ia-flow', 'status:refine', 'field:Priority=high'] }),
      ],
    })
    const source = new GitHubIssueSource(CONFIG, api)
    const [raw] = await source.getItems()
    const item = source.toIssueItem(raw)
    expect(item.fields).toEqual({ Priority: 'high' })
  })

  test('getFields discovers field names and observed values from the repo label catalog, alongside a synthetic Status field', async () => {
    const api = fakeApi({
      listRepoLabels: async () => [
        'bug',
        'status:refine',
        'status:done',
        'field:Priority=high',
        'field:Priority=low',
        'field:Size=M',
      ],
    })
    const source = new GitHubIssueSource(CONFIG, api)
    const fields = await source.getFields()
    expect(fields).toEqual([
      { name: 'Status', dataType: 'SINGLE_SELECT', options: ['refine', 'done'] },
      // `Labels` es el campo multi-valor: sus opciones son las labels de
      // usuario, sin el bookkeeping del source (ancla, `status:*`, `field:*`).
      { name: 'Labels', dataType: 'MULTI_SELECT', options: ['bug'] },
      { name: 'Assignees', dataType: 'TEXT' },
      { name: 'Repository', dataType: 'TEXT' },
      { name: 'Priority', dataType: 'TEXT', options: ['high', 'low'] },
      { name: 'Size', dataType: 'TEXT', options: ['M'] },
    ])
  })

  test('getFields excluye el anchorLabel de las opciones de Labels', async () => {
    // El ancla decide qué issues entran al engine, no es una label que un
    // outcome deba poder agregar o quitar desde el editor.
    const api = fakeApi({ listRepoLabels: async () => ['ia-flow', 'bug'] })
    const source = new GitHubIssueSource(CONFIG, api)
    const labelsField = (await source.getFields()).find((f) => f.name === 'Labels')
    expect(labelsField?.options).toEqual(['bug'])
  })

  test('getFields still returns the synthetic Status field when the repo has no field:* labels yet', async () => {
    const api = fakeApi({ listRepoLabels: async () => ['bug', 'status:refine'] })
    const source = new GitHubIssueSource(CONFIG, api)
    const fields = await source.getFields()
    expect(fields).toEqual([
      { name: 'Status', dataType: 'SINGLE_SELECT', options: ['refine'] },
      { name: 'Labels', dataType: 'MULTI_SELECT', options: ['bug'] },
      { name: 'Assignees', dataType: 'TEXT' },
      { name: 'Repository', dataType: 'TEXT' },
    ])
  })

  test('getFields expone Assignees y Repository — el evaluador de `when` ya los resuelve', async () => {
    // Sin declararlos, el editor de condiciones no los ofrecía y una condición
    // guardada sobre `assignees` quedaba con el campo vacío, aunque el engine
    // la evaluara bien (FIELD_ALIASES en dispatch/when.ts).
    const api = fakeApi({ listRepoLabels: async () => ['bug'] })
    const source = new GitHubIssueSource(CONFIG, api)
    const fields = await source.getFields()
    // Sin `options`: el catálogo de logins/repos no vale una request extra, y
    // el editor cae al input libre — que es lo que hace falta para un login.
    expect(fields.find((f) => f.name === 'Assignees')).toEqual({
      name: 'Assignees',
      dataType: 'TEXT',
    })
    expect(fields.find((f) => f.name === 'Repository')).toEqual({
      name: 'Repository',
      dataType: 'TEXT',
    })
  })
})

describe('GitHubIssueSource.getItemById', () => {
  test('fetches directly via api.getById — not a scan over getItems()', async () => {
    let listIssuesCalls = 0
    const api = fakeApi({
      listIssues: async () => {
        listIssuesCalls++
        return []
      },
      getById: async (id) => (id === 'ISSUE_1' ? issue() : null),
    })
    const source = new GitHubIssueSource(CONFIG, api)
    const item = await source.getItemById('ISSUE_1')
    expect(item?.id).toBe('ISSUE_1')
    expect(listIssuesCalls).toBe(0)
  })

  test('returns null when the issue does not resolve', async () => {
    const source = new GitHubIssueSource(CONFIG, fakeApi())
    expect(await source.getItemById('nope')).toBeNull()
  })
})

function payloadFor(overrides: {
  node_id: string
  number: number
  title?: string
  labels?: string[]
}): { event: string; payload: Record<string, unknown> } {
  return {
    event: 'issues',
    payload: {
      issue: {
        node_id: overrides.node_id,
        number: overrides.number,
        title: overrides.title ?? 'From payload',
        body: '',
        state: 'open',
        labels: (overrides.labels ?? ['ia-flow']).map((name) => ({ name })),
        assignees: [],
        html_url: `https://github.com/la-haus/ia-flow/issues/${overrides.number}`,
      },
    },
  }
}
const HINT = { event: 'issues', repoFullName: 'la-haus/ia-flow' }

describe('GitHubIssueSource.watch — webhook mode', () => {
  test('resolves a SourceItem directly from the payload, without calling the API', async () => {
    const calls = { getByNumber: 0, listIssues: 0 }
    const api = fakeApi({
      getByNumber: async () => {
        calls.getByNumber++
        return null
      },
      listIssues: async () => {
        calls.listIssues++
        return []
      },
    })
    const source = new GitHubIssueSource(CONFIG, api)
    const seen: SourceItem[][] = []
    const disposable = source.watch((items) => seen.push(items), {
      projectId: 'p-payload',
      mode: 'webhook',
      debounceMs: 10,
    })

    await deliverWebhook(HINT, payloadFor({ node_id: 'ISSUE_99', number: 99 }))
    await new Promise((r) => setTimeout(r, 40))

    expect(seen).toHaveLength(1)
    expect(seen[0][0].id).toBe('ISSUE_99')
    expect(calls.getByNumber).toBe(0)
    expect(calls.listIssues).toBe(0)
    disposable.dispose()
  })

  test('falls back to getByNumber when the payload issue is incomplete', async () => {
    const calls: number[] = []
    const api = fakeApi({
      getByNumber: async (_o, _r, n) => {
        calls.push(n)
        return issue({ id: 'ISSUE_55', number: 55 })
      },
    })
    const source = new GitHubIssueSource(CONFIG, api)
    const seen: SourceItem[][] = []
    const disposable = source.watch((items) => seen.push(items), {
      projectId: 'p-fallback-number',
      mode: 'webhook',
      debounceMs: 10,
    })

    // No node_id → fromWebhookPayload() can't build a RestIssue from this.
    await deliverWebhook(HINT, { event: 'issues', payload: { issue: { number: 55 } } })
    await new Promise((r) => setTimeout(r, 40))

    expect(calls).toEqual([55])
    expect(seen[0][0].id).toBe('ISSUE_55')
    disposable.dispose()
  })

  test('falls back to a full getItems() scan when there is no delivery payload (manual nudge)', async () => {
    let listIssuesCalls = 0
    const api = fakeApi({
      listIssues: async () => {
        listIssuesCalls++
        return [issue({ id: 'ISSUE_A' })]
      },
    })
    const source = new GitHubIssueSource(CONFIG, api)
    const seen: SourceItem[][] = []
    const disposable = source.watch((items) => seen.push(items), {
      projectId: 'p-no-delivery',
      mode: 'webhook',
      debounceMs: 10,
    })

    triggerWebhookTarget('p-no-delivery', 'manual:test')
    await new Promise((r) => setTimeout(r, 40))

    expect(listIssuesCalls).toBe(1)
    expect(seen[0][0].id).toBe('ISSUE_A')
    disposable.dispose()
  })

  test('debounces per item id: repeated events for the same issue coalesce to its latest state', async () => {
    const source = new GitHubIssueSource(CONFIG, fakeApi())
    const seen: SourceItem[][] = []
    const disposable = source.watch((items) => seen.push(items), {
      projectId: 'p-debounce-same',
      mode: 'webhook',
      debounceMs: 60,
    })

    await deliverWebhook(HINT, payloadFor({ node_id: 'ISSUE_X', number: 7, title: 'first' }))
    await deliverWebhook(HINT, payloadFor({ node_id: 'ISSUE_X', number: 7, title: 'second' }))
    await deliverWebhook(HINT, payloadFor({ node_id: 'ISSUE_X', number: 7, title: 'third' }))
    await new Promise((r) => setTimeout(r, 100))

    expect(seen).toHaveLength(1)
    expect(seen[0]).toHaveLength(1)
    expect(seen[0][0].title).toBe('third')
    disposable.dispose()
  })

  test('events for different issues in the same window are emitted together', async () => {
    const source = new GitHubIssueSource(CONFIG, fakeApi())
    const seen: SourceItem[][] = []
    const disposable = source.watch((items) => seen.push(items), {
      projectId: 'p-debounce-diff',
      mode: 'webhook',
      debounceMs: 60,
    })

    await deliverWebhook(HINT, payloadFor({ node_id: 'A', number: 1 }))
    await deliverWebhook(HINT, payloadFor({ node_id: 'B', number: 2 }))
    await new Promise((r) => setTimeout(r, 100))

    expect(seen).toHaveLength(1)
    expect(seen[0].map((i) => i.id).sort()).toEqual(['A', 'B'])
    disposable.dispose()
  })

  test('dispose() unregisters — later deliveries resolve nothing', async () => {
    const source = new GitHubIssueSource(CONFIG, fakeApi())
    const seen: SourceItem[][] = []
    const disposable = source.watch((items) => seen.push(items), {
      projectId: 'p-dispose',
      mode: 'webhook',
      debounceMs: 10,
    })
    disposable.dispose()

    const triggered = await deliverWebhook(HINT, payloadFor({ node_id: 'X', number: 1 }))
    expect(triggered).toEqual([])
    await new Promise((r) => setTimeout(r, 30))
    expect(seen).toHaveLength(0)
  })
})

describe('GitHubIssueSource.watch — polling mode', () => {
  test('arms a timer without an immediate tick', async () => {
    let calls = 0
    const api = fakeApi({
      listIssues: async () => {
        calls++
        return []
      },
    })
    const source = new GitHubIssueSource(CONFIG, api)
    const disposable = source.watch(() => {}, {
      projectId: 'p-poll',
      mode: 'polling',
      intervalMs: 25,
    })

    await new Promise((r) => setTimeout(r, 5))
    expect(calls).toBe(0)

    await new Promise((r) => setTimeout(r, 45))
    expect(calls).toBeGreaterThan(0)

    disposable.dispose()
  })
})

describe('GitHubIssueSource sin anchorLabel', () => {
  test('getItems pide los issues sin filtrar por label', async () => {
    // El contrato con el cliente REST es "label undefined = todos": si acá se
    // colara un '' , GitHub interpretaría `labels=` como "ninguna label
    // matchea" y el engine no vería un solo issue.
    const seen: Array<string | undefined> = []
    const api = fakeApi({
      listIssues: async (_o, _r, label) => {
        seen.push(label)
        return [issue({ labels: ['status:refine'] })]
      },
    })
    const source = new GitHubIssueSource(ANCHORLESS_CONFIG, api)
    const items = await source.getItems()
    expect(seen).toEqual([undefined])
    expect(items).toHaveLength(1)
    expect(items[0].status).toBe('refine')
  })

  test('onDaemonStart limpia el working label sin filtrar por ancla', async () => {
    const seen: Array<string | undefined> = []
    const cleared: string[][] = []
    const api = fakeApi({
      listIssues: async (_o, _r, label) => {
        seen.push(label)
        return [issue({ labels: ['status:refine', WORKING_LABEL] })]
      },
      replaceLabels: async (_o, _r, _n, labels) => {
        cleared.push(labels)
      },
    })
    await new GitHubIssueSource(ANCHORLESS_CONFIG, api).onDaemonStart()
    expect(seen).toEqual([undefined])
    expect(cleared[0]).not.toContain(WORKING_LABEL)
  })

  test('createItem no estampa ninguna label ancla', async () => {
    const calls: string[][] = []
    const api = fakeApi({
      create: async () => issue({ labels: [] }),
      replaceLabels: async (_o, _r, _n, labels) => {
        calls.push(labels)
      },
    })
    const source = new GitHubIssueSource(ANCHORLESS_CONFIG, api)
    await source.createItem({ title: 'x', status: 'refine' })
    expect(calls[0]).toEqual(['status:refine'])
  })

  test('createItem sin status ni ancla manda un set de labels vacío', async () => {
    const calls: string[][] = []
    const api = fakeApi({
      create: async () => issue({ labels: [] }),
      replaceLabels: async (_o, _r, _n, labels) => {
        calls.push(labels)
      },
    })
    const source = new GitHubIssueSource(ANCHORLESS_CONFIG, api)
    await source.createItem({ title: 'x' })
    expect(calls[0]).toEqual([])
  })

  test('setLabels no inyecta un undefined en el set de labels', async () => {
    // protectBookkeeping re-agrega el ancla; sin ancla no debe agregar nada
    // (un `out.add(undefined)` terminaría viajando a la API de GitHub).
    const calls: string[][] = []
    const api = fakeApi({
      getByNumber: async () => issue({ labels: ['status:refine', 'bug'] }),
      replaceLabels: async (_o, _r, _n, labels) => {
        calls.push(labels)
      },
    })
    const source = new GitHubIssueSource(ANCHORLESS_CONFIG, api)
    const item = source.toIssueItem({
      id: 'ISSUE_1',
      title: 'x',
      status: 'refine',
      meta: { issueId: 'ISSUE_1', issueNumber: 42, labels: ['status:refine', 'bug'] },
    })
    const taskSource = new GitHubIssueTaskSource(
      ANCHORLESS_CONFIG,
      api,
      new StatusLabelCodec(),
      new FieldLabelCodec(),
      item,
      () => {},
    )
    await taskSource.setLabels(
      {
        id: 'ISSUE_1',
        title: 'x',
        description: '',
        status: 'refine',
        type: 'functional' as const,
        repos: ['ia-flow'],
        created_at: '',
      },
      ['deployed'],
    )
    expect(calls[0].every((l) => typeof l === 'string')).toBe(true)
    expect(calls[0]).toContain('deployed')
    expect(calls[0]).toContain('status:refine')
  })
})

// El link del hilo de review vive en el cuerpo del issue (canónico, gratis de
// leer en el scan) y se copia al PR. La caída al PR cuando el issue no tiene
// nada no se cubre acá: es una llamada GraphQL real (`readSlackThreadUrlFromPr`)
// y su parseo ya está testeado en github-shared/test/slack-section.test.ts.
describe('GitHubIssueSource — hilo de review en Slack', () => {
  const THREAD = 'https://acme.slack.com/archives/C1/p1699999999123456'

  test('publica meta.slackThreadUrl desde el cuerpo del issue — gratis, sin request extra', async () => {
    const body = upsertSlackSection('El PRD', THREAD)
    const api = fakeApi({ listIssues: async () => [issue({ body })] })
    const source = new GitHubIssueSource(CONFIG, api)
    const [item] = await source.getItems()
    expect(item.meta?.slackThreadUrl).toBe(THREAD)
    expect(await source.getSlackThreadUrl(source.toIssueItem(item))).toBe(THREAD)
  })

  test('sin bloque no hay link: es el "primer review"', async () => {
    const api = fakeApi({ listIssues: async () => [issue({ body: 'El PRD' })] })
    const source = new GitHubIssueSource(CONFIG, api)
    const [item] = await source.getItems()
    expect(item.meta?.slackThreadUrl).toBeUndefined()
  })

  test('el bloque no se filtra a la descripción que lee el agente', async () => {
    const body = upsertSlackSection('El PRD', THREAD)
    const api = fakeApi({ listIssues: async () => [issue({ body })] })
    const source = new GitHubIssueSource(CONFIG, api)
    const [raw] = await source.getItems()
    expect(source.toIssueItem(raw).description).toBe('El PRD')
  })

  test('setSlackThreadUrl escribe el cuerpo del issue', async () => {
    const writes: Array<{ id: string; body: string }> = []
    const api = fakeApi({
      listIssues: async () => [issue({ body: 'El PRD' })],
      getById: async () => issue({ body: 'El PRD' }),
      updateBody: async (id: string, body: string) => {
        writes.push({ id, body })
      },
    })
    const source = new GitHubIssueSource(CONFIG, api)
    const [raw] = await source.getItems()
    await source.setSlackThreadUrl(source.toIssueItem(raw), THREAD)
    expect(writes).toHaveLength(1)
    expect(writes[0].id).toBe('ISSUE_1')
    expect(writes[0].body.startsWith('El PRD')).toBe(true)
    expect(extractSlackThreadUrl(writes[0].body)).toBe(THREAD)
  })

  // Sin PR abierto ya no falla: el issue es el que manda, y antes de esto el
  // pedido de review reportaba `threadNotPersisted` en ese caso.
  test('sin PR abierto guarda igual', async () => {
    const api = fakeApi({
      listIssues: async () => [issue({ body: '' })],
      getById: async () => issue({ body: '' }),
      updateBody: async () => {},
    })
    const source = new GitHubIssueSource(CONFIG, api)
    const [raw] = await source.getItems()
    expect(source.setSlackThreadUrl(source.toIssueItem(raw), THREAD)).resolves.toBeUndefined()
  })

  // Entre el scan y este write corren dos llamadas a Slack (postMessage +
  // getPermalink), y acá se escribe el cuerpo ENTERO: sin re-leer, un PRD
  // guardado en esa ventana volvía silenciosamente a la versión vieja.
  test('setSlackThreadUrl re-lee el body: no revierte lo que se escribió mientras tanto', async () => {
    const writes: string[] = []
    const api = fakeApi({
      listIssues: async () => [issue({ body: 'PRD viejo' })],
      getById: async () => issue({ body: 'PRD nuevo, escrito por un agente' }),
      updateBody: async (_id: string, body: string) => {
        writes.push(body)
      },
    })
    const source = new GitHubIssueSource(CONFIG, api)
    const [raw] = await source.getItems()
    await source.setSlackThreadUrl(source.toIssueItem(raw), THREAD)
    expect(writes[0].startsWith('PRD nuevo, escrito por un agente')).toBe(true)
    expect(writes[0]).not.toContain('PRD viejo')
    expect(extractSlackThreadUrl(writes[0])).toBe(THREAD)
  })

  test('updateItem manda el título nuevo a la mutation', async () => {
    const writes: Array<{ id: string; body: string; title?: string }> = []
    const api = fakeApi({
      getById: async () => issue({ body: 'PRD' }),
      updateBody: async (id: string, body: string, title?: string) => {
        writes.push({ id, body, title })
      },
    })
    const source = new GitHubIssueSource(CONFIG, api)
    await source.updateItem('ISSUE_1', { title: 'Título nuevo' })
    expect(writes).toHaveLength(1)
    expect(writes[0].title).toBe('Título nuevo')
    // El body no vino en el patch — se re-manda el actual para no vaciarlo.
    expect(writes[0].body).toBe('PRD')
  })

  test('reescribir la descripción no borra el link del hilo', async () => {
    const stored = { body: upsertSlackSection('PRD viejo', THREAD) }
    const api = fakeApi({
      getById: async () => issue({ body: stored.body }),
      updateBody: async (_id: string, body: string) => {
        stored.body = body
      },
    })
    const source = new GitHubIssueSource(CONFIG, api)
    await source.updateItem('ISSUE_1', { description: 'PRD nuevo' })
    expect(stored.body.startsWith('PRD nuevo')).toBe(true)
    expect(extractSlackThreadUrl(stored.body)).toBe(THREAD)
  })

  test('saveOutput del agente tampoco lo borra', async () => {
    const stored = { body: upsertSlackSection('PRD viejo', THREAD) }
    const api = fakeApi({
      getById: async () => issue({ body: stored.body }),
      updateBody: async (_id: string, body: string) => {
        stored.body = body
      },
    })
    const item = {
      id: 'ISSUE_1',
      issueNumber: 42,
      meta: { issueId: 'ISSUE_1', issueNumber: 42 },
    } as unknown as IssueItem
    const taskSource = new GitHubIssueTaskSource(
      CONFIG,
      api,
      new StatusLabelCodec(),
      new FieldLabelCodec(),
      item,
      () => {},
    )
    await taskSource.saveOutput(
      {
        id: 'ISSUE_1',
        title: 'x',
        description: '',
        status: 'refine',
        type: 'functional' as const,
        repos: ['ia-flow'],
        created_at: '',
      },
      'PRD refinado',
    )
    expect(stored.body.startsWith('PRD refinado')).toBe(true)
    expect(extractSlackThreadUrl(stored.body)).toBe(THREAD)
  })
})
