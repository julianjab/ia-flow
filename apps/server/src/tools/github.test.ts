import { describe, expect, it, beforeAll, afterEach } from 'bun:test'
import { getTool, registerTool, getToolDefinitions } from './index.js'
import type { ToolContext } from './index.js'

// Register github tools by importing the module (side-effect: calls registerTool)
import './github.js'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch

beforeAll(() => {
  process.env.GITHUB_TOKEN = 'test-token'
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

type FetchCall = { url: string; body: unknown }

function stubFetch(response: unknown = {}): { calls: FetchCall[] } {
  const calls: FetchCall[] = []
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: url as string, body: init?.body ? JSON.parse(init.body as string) : null })
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { calls }
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    repoPaths: {},
    github: {
      owner: 'acme',
      projectId: 'PVT_1',
      fields: {
        Status: { id: 'f_status', options: [{ id: 'opt_queue', name: 'Queue' }, { id: 'opt_done', name: 'Done' }] },
        'Task Type': { id: 'f_type', options: [{ id: 'opt_func', name: 'Functional' }] },
        Notes: { id: 'f_notes' },
      },
      itemId: 'PVTI_1',
      issueId: 'I_node1',
      repoName: 'my-repo',
      issueNumber: 42,
    },
    ...overrides,
  }
}

// ─── Tool registration ────────────────────────────────────────────────────────

describe('tool registration', () => {
  it('registers create_github_issue', () => {
    expect(getTool('create_github_issue')).toBeDefined()
  })

  it('registers add_to_project', () => {
    expect(getTool('add_to_project')).toBeDefined()
  })

  it('registers set_project_field', () => {
    expect(getTool('set_project_field')).toBeDefined()
  })

  it('registers add_sub_issue', () => {
    expect(getTool('add_sub_issue')).toBeDefined()
  })

  it('registers add_issue_labels', () => {
    expect(getTool('add_issue_labels')).toBeDefined()
  })

  it('registers add_issue_comment', () => {
    expect(getTool('add_issue_comment')).toBeDefined()
  })

  it('all github tools appear in getToolDefinitions()', () => {
    const defs = getToolDefinitions().map(d => d.name)
    for (const name of ['create_github_issue', 'add_to_project', 'set_project_field', 'add_sub_issue', 'add_issue_labels', 'add_issue_comment']) {
      expect(defs).toContain(name)
    }
  })
})

// ─── requireGitHub guard ──────────────────────────────────────────────────────

describe('requireGitHub guard', () => {
  it('throws when ctx.github is absent for create_github_issue', async () => {
    const tool = getTool('create_github_issue')!
    const ctx: ToolContext = { repoPaths: {} }
    await expect(tool.execute({ repo: 'x', title: 'T', body: 'B' }, ctx)).rejects.toThrow('GitHub context not available')
  })

  it('throws for add_to_project when no GitHub context', async () => {
    const tool = getTool('add_to_project')!
    await expect(tool.execute({ issue_node_id: 'I_1' }, { repoPaths: {} })).rejects.toThrow('GitHub context not available')
  })

  it('throws for set_project_field when no GitHub context', async () => {
    const tool = getTool('set_project_field')!
    await expect(tool.execute({ field_name: 'Status', value: 'Done' }, { repoPaths: {} })).rejects.toThrow('GitHub context not available')
  })
})

// ─── create_github_issue ──────────────────────────────────────────────────────

describe('create_github_issue', () => {
  it('calls GitHub REST API and returns issue info', async () => {
    const { calls } = stubFetch({
      node_id: 'I_abc',
      number: 7,
      id: 999,
    })
    const ctx = makeCtx()
    const tool = getTool('create_github_issue')!
    const result = JSON.parse(await tool.execute({ repo: 'my-repo', title: 'New issue', body: 'Body text' }, ctx))

    expect(result.issueNumber).toBe(7)
    expect(result.issueId).toBe('I_abc')
    expect(result.numericId).toBe(999)
    expect(calls.length).toBeGreaterThanOrEqual(1)
  })
})

// ─── add_to_project ───────────────────────────────────────────────────────────

describe('add_to_project', () => {
  it('calls GraphQL and returns itemId', async () => {
    stubFetch({ data: { addProjectV2ItemById: { item: { id: 'PVTI_new' } } } })
    const ctx = makeCtx()
    const tool = getTool('add_to_project')!
    const result = JSON.parse(await tool.execute({ issue_node_id: 'I_node1' }, ctx))

    expect(result.itemId).toBe('PVTI_new')
  })
})

// ─── set_project_field ────────────────────────────────────────────────────────

describe('set_project_field', () => {
  it('calls updateItemStatus for a single-select field', async () => {
    const { calls } = stubFetch({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_1' } } } })
    const ctx = makeCtx()
    const tool = getTool('set_project_field')!
    const result = await tool.execute({ field_name: 'Status', value: 'Done' }, ctx)

    expect(result).toContain('Done')
    expect(calls.length).toBe(1)
  })

  it('calls setProjectTextField for a text field', async () => {
    const { calls } = stubFetch({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_1' } } } })
    const ctx = makeCtx()
    const tool = getTool('set_project_field')!
    const result = await tool.execute({ field_name: 'Notes', value: 'some text' }, ctx)

    expect(result).toContain('Notes')
    expect(calls.length).toBe(1)
  })

  it('throws when field_name is unknown', async () => {
    const ctx = makeCtx()
    const tool = getTool('set_project_field')!
    await expect(tool.execute({ field_name: 'UnknownField', value: 'x' }, ctx))
      .rejects.toThrow("Field 'UnknownField' not found")
  })
})

// ─── add_issue_labels ─────────────────────────────────────────────────────────

describe('add_issue_labels', () => {
  it('calls GitHub REST API to add labels', async () => {
    const { calls } = stubFetch([{ id: 1, name: 'bug' }])
    const ctx = makeCtx()
    const tool = getTool('add_issue_labels')!
    const result = await tool.execute({ labels: ['bug', 'enhancement'] }, ctx)

    expect(result).toContain('bug')
    expect(calls.length).toBeGreaterThanOrEqual(1)
  })

  it('throws when repoName or issueNumber are absent', async () => {
    const ctx = makeCtx()
    ctx.github!.repoName = undefined
    const tool = getTool('add_issue_labels')!
    await expect(tool.execute({ labels: ['bug'] }, ctx)).rejects.toThrow('repoName and issueNumber are required')
  })
})

// ─── add_issue_comment ────────────────────────────────────────────────────────

describe('add_issue_comment', () => {
  it('posts a comment to the issue', async () => {
    const { calls } = stubFetch({ data: { addComment: { commentEdge: { node: { id: 'c_1' } } } } })
    const ctx = makeCtx()
    const tool = getTool('add_issue_comment')!
    const result = await tool.execute({ issue_node_id: 'I_node1', body: 'Nice work!' }, ctx)

    expect(result).toBe('Comment posted')
    expect(calls.length).toBeGreaterThanOrEqual(1)
  })

  it('falls back to ctx.github.issueId when issue_node_id is "unknown"', async () => {
    const { calls } = stubFetch({ data: { addComment: { commentEdge: { node: { id: 'c_2' } } } } })
    const ctx = makeCtx()
    const tool = getTool('add_issue_comment')!
    const result = await tool.execute({ issue_node_id: 'unknown', body: 'Fallback comment' }, ctx)

    expect(result).toBe('Comment posted')
    expect(calls.length).toBeGreaterThanOrEqual(1)
    const body = calls[0].body as any
    expect(body.variables.issueId).toBe('I_node1')
  })

  it('falls back to ctx.github.issueId when issue_node_id is omitted', async () => {
    stubFetch({ data: { addComment: { commentEdge: { node: { id: 'c_3' } } } } })
    const ctx = makeCtx()
    const tool = getTool('add_issue_comment')!
    const result = await tool.execute({ body: 'No node id' }, ctx)
    expect(result).toBe('Comment posted')
  })

  it('throws when issue_node_id is unknown and no ctx.github available', async () => {
    const ctx = makeCtx({ github: undefined })
    const tool = getTool('add_issue_comment')!
    await expect(tool.execute({ issue_node_id: 'unknown', body: 'oops' }, ctx)).rejects.toThrow(
      'issue_node_id is required',
    )
  })
})
