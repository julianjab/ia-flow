import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import type { SourceItem } from '../../contract.js'
import { deliverWebhook, triggerWebhookTarget } from '../../dispatch/webhook-registry.js'
import { GitHubProjectSource } from '../source.js'

// Same fetch-stubbing approach as task-source.test.ts — GitHubProjectSource
// (and the free functions in api/project.ts it calls) talk to GitHub via a
// single gql() POST, routed here by inspecting `variables` instead of
// operation name (these queries are all anonymous — see the real
// "github graphql anonymous" log lines this produces in production).
const originalFetch = globalThis.fetch

beforeAll(() => {
  process.env.GITHUB_TOKEN = 'test-token'
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

type Call = { variables: Record<string, unknown> }

const META_RESPONSE = {
  organization: {
    projectV2: {
      id: 'PVT_1',
      fields: {
        nodes: [
          {
            id: 'f_status',
            name: 'Status',
            dataType: 'SINGLE_SELECT',
            options: [{ id: 'o1', name: 'build' }],
          },
          { id: 'f_working', name: 'Working', dataType: 'SINGLE_SELECT', options: [] },
        ],
      },
    },
  },
}

function itemNode(
  overrides: { id?: string; number?: number; title?: string; status?: string } = {},
) {
  return {
    id: overrides.id ?? 'PVTI_1',
    content: {
      id: `I_${overrides.number ?? 42}`,
      number: overrides.number ?? 42,
      title: overrides.title ?? 'Do the thing',
      body: 'body text',
      repository: { name: 'repo-a' },
      labels: { nodes: [] },
      assignees: { nodes: [] },
      linkedBranches: { nodes: [] },
    },
    fieldValues: {
      nodes: [{ field: { id: 'f_status', name: 'Status' }, name: overrides.status ?? 'build' }],
    },
  }
}

function stubFetch(
  router: (variables: Record<string, unknown>) => unknown,
  opts: { delayMetaMs?: number } = {},
): { calls: Call[] } {
  const calls: Call[] = []
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string)
    calls.push({ variables: body.variables })
    if (opts.delayMetaMs && (body.variables.org || body.variables.user)) {
      await new Promise((r) => setTimeout(r, opts.delayMetaMs))
    }
    const data = router(body.variables)
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { calls }
}

function router(variables: Record<string, unknown>): unknown {
  if (variables.org || variables.user) return META_RESPONSE
  if (variables.itemId) return { node: itemNode() }
  if (variables.projectId) return { node: { items: { nodes: [itemNode()] } } }
  throw new Error(`stubFetch: unrouted variables ${JSON.stringify(variables)}`)
}

const URL = 'https://github.com/orgs/acme/projects/1'

describe('GitHubProjectSource.getItemById', () => {
  test('fetches directly via node(id) — never a full board scan', async () => {
    const { calls } = stubFetch(router)
    const source = new GitHubProjectSource(URL)
    const item = await source.getItemById('PVTI_1')
    expect(item?.id).toBe('PVTI_1')
    expect(item?.status).toBe('build')
    // One meta call + one itemId call — never a projectId (full list) call.
    expect(calls.some((c) => c.variables.projectId)).toBe(false)
    expect(calls.some((c) => c.variables.itemId)).toBe(true)
  })

  test('returns null when the item does not resolve', async () => {
    stubFetch((v) => (v.itemId ? { node: null } : META_RESPONSE))
    const source = new GitHubProjectSource(URL)
    expect(await source.getItemById('nope')).toBeNull()
  })
})

describe('GitHubProjectSource.watch — polling mode', () => {
  test('arms a timer without an immediate tick, then fetches the full list', async () => {
    const { calls } = stubFetch(router)
    const source = new GitHubProjectSource(URL)
    const seen: SourceItem[][] = []
    const disposable = source.watch((items) => seen.push(items), {
      projectId: 'p1',
      mode: 'polling',
      intervalMs: 25,
    })

    await new Promise((r) => setTimeout(r, 5))
    expect(calls.some((c) => c.variables.projectId)).toBe(false)

    await new Promise((r) => setTimeout(r, 60))
    expect(calls.some((c) => c.variables.projectId)).toBe(true)
    expect(seen.length).toBeGreaterThan(0)

    disposable.dispose()
  })
})

describe('GitHubProjectSource.watch — webhook mode', () => {
  test('warms loadMeta before registering — dispose() during warmup registers nothing', async () => {
    const { calls } = stubFetch(router, { delayMetaMs: 40 })
    const source = new GitHubProjectSource(URL)
    const disposable = source.watch(() => {}, { projectId: 'p-warmup', mode: 'webhook' })
    disposable.dispose() // fires before the delayed meta call resolves

    await new Promise((r) => setTimeout(r, 80))
    // loadMeta still ran (can't cancel the in-flight fetch), but nothing
    // should have registered as a webhook target afterwards.
    expect(calls.length).toBeGreaterThan(0)
    const triggered = triggerWebhookTarget('p-warmup', 'manual:test')
    expect(triggered).toBe(false)
  })

  test('fast path: a projects_v2_item delivery resolves via getItemById, never a full scan', async () => {
    const { calls } = stubFetch(router)
    const source = new GitHubProjectSource(URL)
    const seen: SourceItem[][] = []
    const disposable = source.watch((items) => seen.push(items), {
      projectId: 'p-fast',
      mode: 'webhook',
      debounceMs: 10,
    })
    await new Promise((r) => setTimeout(r, 20)) // let the loadMeta warmup finish

    await deliverWebhook(
      { event: 'projects_v2_item', projectNodeId: 'PVT_1' },
      { event: 'projects_v2_item', payload: { projects_v2_item: { node_id: 'PVTI_1' } } },
    )
    await new Promise((r) => setTimeout(r, 40))

    expect(seen).toHaveLength(1)
    expect(seen[0][0].id).toBe('PVTI_1')
    expect(calls.some((c) => c.variables.itemId)).toBe(true)
    expect(calls.some((c) => c.variables.projectId)).toBe(false)

    disposable.dispose()
  })

  test('falls back to a full scan for issues/issue_comment deliveries (no board item id)', async () => {
    const { calls } = stubFetch(router)
    const source = new GitHubProjectSource(URL)
    const seen: SourceItem[][] = []
    const disposable = source.watch((items) => seen.push(items), {
      projectId: 'p-fallback',
      mode: 'webhook',
      debounceMs: 10,
    })
    await new Promise((r) => setTimeout(r, 20))

    await deliverWebhook(
      { event: 'issues', repoFullName: 'acme/repo-a' },
      { event: 'issues', payload: { issue: { number: 42 } } },
    )
    await new Promise((r) => setTimeout(r, 40))

    expect(seen).toHaveLength(1)
    expect(calls.some((c) => c.variables.projectId)).toBe(true)

    disposable.dispose()
  })
})
