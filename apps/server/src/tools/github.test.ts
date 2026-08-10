import { afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { getTool, getToolDefinitions } from './index.js'
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
      fields: {},
      itemId: 'PVTI_1',
      issueId: 'I_node1',
      repoName: 'my-repo',
      issueNumber: 42,
    },
    ...overrides,
  }
}

// ─── Tool registration ────────────────────────────────────────────────────────

describe('tool registration (github-only)', () => {
  it('registers create_github_issue', () => {
    expect(getTool('create_github_issue')).toBeDefined()
  })

  it('registers add_to_project', () => {
    expect(getTool('add_to_project')).toBeDefined()
  })

  it('registers add_sub_issue', () => {
    expect(getTool('add_sub_issue')).toBeDefined()
  })

  it('all github-only tools appear in getToolDefinitions()', () => {
    const defs = getToolDefinitions().map((d) => d.name)
    for (const name of ['create_github_issue', 'add_to_project', 'add_sub_issue']) {
      expect(defs).toContain(name)
    }
  })

  it('no longer registers legacy task-scoped names in github.ts', () => {
    // These have moved to tools/task.ts as add_task_comment / set_task_field /
    // set_task_labels and route via ITransitionManager. The old names are
    // rewritten to the new ones by migration 010.
    const defs = getToolDefinitions().map((d) => d.name)
    for (const legacy of ['set_project_field', 'add_issue_labels', 'add_issue_comment']) {
      expect(defs).not.toContain(legacy)
    }
  })
})

// ─── requireGitHub guard ──────────────────────────────────────────────────────

describe('requireGitHub guard', () => {
  it('throws when ctx.github is absent for create_github_issue', async () => {
    const tool = getTool('create_github_issue')!
    const ctx: ToolContext = { repoPaths: {} }
    await expect(tool.execute({ repo: 'x', title: 'T', body: 'B' }, ctx)).rejects.toThrow(
      'GitHub context not available',
    )
  })

  it('throws for add_to_project when no GitHub context', async () => {
    const tool = getTool('add_to_project')!
    await expect(tool.execute({ issue_node_id: 'I_1' }, { repoPaths: {} })).rejects.toThrow(
      'GitHub context not available',
    )
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
    const result = JSON.parse(
      await tool.execute({ repo: 'my-repo', title: 'New issue', body: 'Body text' }, ctx),
    )

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
