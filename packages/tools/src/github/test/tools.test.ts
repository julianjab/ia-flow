import { afterEach, beforeAll, describe, expect, it } from 'bun:test'
import type { ToolContext } from '../../contract.js'
import { getTool, getToolDefinitions } from '../../engine.js'
// Register github tools by importing the module (side-effect: calls registerTool)
import { setRepoResolverPort } from '../tools.js'
import '../tools.js'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch

beforeAll(() => {
  process.env.GITHUB_TOKEN = 'test-token'
  // Mirrors apps/server's resolveGithubRepo fallback when a repo name has no
  // explicit DB mapping: pass the local name through as-is, owner from ctx.
  setRepoResolverPort({
    resolveGithubRepo: async (localName, defaultOwner) => ({
      owner: defaultOwner,
      repo: localName,
    }),
  })
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
    sourceContext: {
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

  it('registers list_sub_issues_brief', () => {
    expect(getTool('list_sub_issues_brief')).toBeDefined()
  })

  it('all github-only tools appear in getToolDefinitions()', () => {
    const defs = getToolDefinitions().map((d) => d.name)
    for (const name of [
      'create_github_issue',
      'add_to_project',
      'add_sub_issue',
      'list_sub_issues_brief',
    ]) {
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

  it('passes labels through to the REST body when provided', async () => {
    const { calls } = stubFetch({ node_id: 'I_abc', number: 7, id: 999 })
    const ctx = makeCtx()
    const tool = getTool('create_github_issue')!
    await tool.execute(
      {
        repo: 'my-repo',
        title: 'New issue',
        body: 'Body text',
        labels: ['ia-flow-refine', 'status:refined'],
      },
      ctx,
    )

    const createCall = calls.find((c) => (c.body as any)?.title === 'New issue')
    expect((createCall!.body as any).labels).toEqual(['ia-flow-refine', 'status:refined'])
  })

  it('works with a github-issues context that has no projectId', async () => {
    stubFetch({ node_id: 'I_abc', number: 7, id: 999 })
    const ctx = makeCtx({
      sourceContext: { owner: 'acme', fields: {}, issueId: 'I_parent', repoName: 'my-repo' },
    })
    const tool = getTool('create_github_issue')!
    const result = JSON.parse(
      await tool.execute({ repo: 'my-repo', title: 'New issue', body: 'Body text' }, ctx),
    )
    expect(result.issueNumber).toBe(7)
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

  it('throws a clear error for a github-issues context with no projectId', async () => {
    const ctx = makeCtx({
      sourceContext: { owner: 'acme', fields: {}, issueId: 'I_parent', repoName: 'my-repo' },
    })
    const tool = getTool('add_to_project')!
    await expect(tool.execute({ issue_node_id: 'I_node1' }, ctx)).rejects.toThrow(
      'requires a GitHub Projects v2 board',
    )
  })
})

// ─── list_sub_issues_brief ────────────────────────────────────────────────────
//
// Existe para NO gastar la ventana de contexto: el `list_sub_issues` del MCP
// devuelve los issues enteros (en el épico #1243 de subscriptions, 21 hijos y
// ~154K caracteres sólo de bodies) y un run del refiner se quedaba sin
// contexto antes de abrir un archivo del repo.

describe('list_sub_issues_brief', () => {
  it('devuelve sólo número/título/estado/url — nunca el body', async () => {
    stubFetch([
      {
        number: 1283,
        title: 'feat(core): cursor round-robin',
        state: 'open',
        html_url: 'https://github.com/acme/my-repo/issues/1283',
        body: 'x'.repeat(10_000),
        labels: [{ name: 'ruido' }],
      },
    ])
    const tool = getTool('list_sub_issues_brief')!
    const raw = await tool.execute({ repo: 'my-repo', parent_issue_number: 1243 }, makeCtx())
    const result = JSON.parse(raw)

    expect(result.count).toBe(1)
    expect(result.subIssues[0]).toEqual({
      number: 1283,
      title: 'feat(core): cursor round-robin',
      state: 'open',
      url: 'https://github.com/acme/my-repo/issues/1283',
    })
    // Lo que motivó la tool: el body del hijo NO viaja en la respuesta.
    expect(raw).not.toContain('xxxx')
    expect(raw.length).toBeLessThan(500)
  })

  it('pagina hasta agotar — un índice truncado en silencio haría concluir que un hermano no existe', async () => {
    const page = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => ({
        number: from + i,
        title: `child ${from + i}`,
        state: 'open',
        html_url: `https://github.com/acme/my-repo/issues/${from + i}`,
      }))
    const urls: string[] = []
    globalThis.fetch = (async (url: string) => {
      urls.push(url as string)
      // Página llena primero, página corta después → corta el loop.
      const body = urls.length === 1 ? page(1, 100) : page(101, 5)
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const tool = getTool('list_sub_issues_brief')!
    const result = JSON.parse(
      await tool.execute({ repo: 'my-repo', parent_issue_number: 1243 }, makeCtx()),
    )

    expect(result.count).toBe(105)
    expect(urls.length).toBe(2)
    expect(urls[0]).toContain('/issues/1243/sub_issues?per_page=100&page=1')
    expect(urls[1]).toContain('page=2')
  })

  it('un padre sin sub-issues devuelve una lista vacía, no un error', async () => {
    stubFetch([])
    const tool = getTool('list_sub_issues_brief')!
    const result = JSON.parse(
      await tool.execute({ repo: 'my-repo', parent_issue_number: 999 }, makeCtx()),
    )

    expect(result).toEqual({ count: 0, subIssues: [] })
  })
})
