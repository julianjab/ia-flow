import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import {
  PR_DIFF_MAX_CHARS,
  branchTreeUrl,
  fetchPullRequestDiff,
  isCiFinished,
  isUnsupportedPullRequestFieldError,
  issueDevLinksSelection,
  mapDevLinks,
  pickPrimaryBranch,
} from '../dev-links.js'

describe('pickPrimaryBranch', () => {
  test('prefers the branch that belongs to the primary repo', () => {
    const nodes = [
      { ref: { name: 'other/branch', repository: { name: 'otro-repo' } } },
      { ref: { name: 'fix/aca', repository: { name: 'ia-flow' } } },
    ]
    expect(pickPrimaryBranch(nodes, 'ia-flow')).toBe('fix/aca')
  })

  test('falls back to the first branch when none matches the repo', () => {
    const nodes = [{ ref: { name: 'other/branch', repository: { name: 'otro-repo' } } }]
    expect(pickPrimaryBranch(nodes, 'ia-flow')).toBe('other/branch')
  })

  test('undefined when there are no linked branches', () => {
    expect(pickPrimaryBranch([], 'ia-flow')).toBeUndefined()
    expect(pickPrimaryBranch(undefined, 'ia-flow')).toBeUndefined()
  })
})

describe('mapDevLinks', () => {
  test('collapses a merged PR into state "merged"', () => {
    const links = mapDevLinks(
      {
        linkedBranches: { nodes: [] },
        closedByPullRequestsReferences: {
          nodes: [
            { number: 1, url: 'u1', state: 'CLOSED', merged: true, isDraft: false, title: 'A' },
            { number: 2, url: 'u2', state: 'CLOSED', merged: false, isDraft: false },
            { number: 3, url: 'u3', state: 'OPEN', merged: false, isDraft: true },
          ],
        },
      },
      'ia-flow',
    )
    expect(links.pullRequests.map((pr) => pr.state)).toEqual(['merged', 'closed', 'open'])
    expect(links.pullRequests[0].title).toBe('A')
    expect(links.pullRequests[2].isDraft).toBe(true)
  })

  test('drops nodes without number or url instead of emitting a broken link', () => {
    const links = mapDevLinks(
      { closedByPullRequestsReferences: { nodes: [{ number: 1 }, { url: 'u' }] } },
      undefined,
    )
    expect(links.pullRequests).toEqual([])
  })

  test('mapea files() a PullRequestFile[] — gratis, misma selección que number/url/ci', () => {
    const links = mapDevLinks(
      {
        closedByPullRequestsReferences: {
          nodes: [
            {
              number: 1,
              url: 'u1',
              state: 'OPEN',
              isDraft: false,
              files: {
                totalCount: 2,
                nodes: [
                  { path: 'core/twilio.py', additions: 12, deletions: 3 },
                  { path: 'core/twilio.test.py', additions: 5, deletions: 0 },
                ],
              },
            },
          ],
        },
      },
      undefined,
    )
    expect(links.pullRequests[0].files).toEqual([
      { path: 'core/twilio.py', additions: 12, deletions: 3 },
      { path: 'core/twilio.test.py', additions: 5, deletions: 0 },
    ])
    expect(links.pullRequests[0].filesTruncated).toBeUndefined()
  })

  test('filesTruncated=true cuando totalCount excede lo que trajo la selección', () => {
    const links = mapDevLinks(
      {
        closedByPullRequestsReferences: {
          nodes: [
            {
              number: 1,
              url: 'u1',
              state: 'OPEN',
              isDraft: false,
              files: { totalCount: 150, nodes: [{ path: 'a.ts', additions: 1, deletions: 1 }] },
            },
          ],
        },
      },
      undefined,
    )
    expect(links.pullRequests[0].filesTruncated).toBe(true)
  })

  test('sin files() en la selección, ni files ni filesTruncated se inventan', () => {
    const links = mapDevLinks(
      { closedByPullRequestsReferences: { nodes: [{ number: 1, url: 'u1', state: 'OPEN' }] } },
      undefined,
    )
    expect(links.pullRequests[0].files).toBeUndefined()
    expect(links.pullRequests[0].filesTruncated).toBeUndefined()
  })

  test('sin linked branch, la rama sale del head del PR', () => {
    const links = mapDevLinks(
      {
        linkedBranches: { nodes: [] },
        closedByPullRequestsReferences: {
          nodes: [
            {
              number: 5,
              url: 'u5',
              state: 'OPEN',
              headRefName: 'fix/sms-service-sid',
              headRepository: { name: 'subscriptions' },
            },
          ],
        },
      },
      'subscriptions',
    )
    expect(links.branch).toBe('fix/sms-service-sid')
    expect(links.branchRepo).toBe('subscriptions')
  })

  test('el linked branch le gana al head del PR cuando hay ambos', () => {
    const links = mapDevLinks(
      {
        linkedBranches: {
          nodes: [{ ref: { name: 'task/linkeada', repository: { name: 'subscriptions' } } }],
        },
        closedByPullRequestsReferences: {
          nodes: [{ number: 5, url: 'u5', state: 'OPEN', headRefName: 'otra/rama' }],
        },
      },
      'subscriptions',
    )
    expect(links.branch).toBe('task/linkeada')
  })

  test('empty dev links for a null/absent content node', () => {
    expect(mapDevLinks(null, 'ia-flow')).toEqual({ pullRequests: [], pullRequestsKnown: true })
  })
})

describe('branchTreeUrl', () => {
  test('no rompe las barras del nombre de la rama', () => {
    expect(branchTreeUrl('la-haus', 'subscriptions', 'fix/sms')).toBe(
      'https://github.com/la-haus/subscriptions/tree/fix/sms',
    )
  })

  test('escapa lo que sí necesita escaparse dentro de un segmento', () => {
    expect(branchTreeUrl('o', 'r', 'feat/a b')).toBe('https://github.com/o/r/tree/feat/a%20b')
  })
})

describe('unsupported PR field detection', () => {
  test('recognises a schema error naming the field', () => {
    const err = new Error(
      "GitHub GraphQL errors: Field 'closedByPullRequestsReferences' doesn't exist on type 'Issue'",
    )
    expect(isUnsupportedPullRequestFieldError(err)).toBe(true)
  })

  test('does not swallow unrelated GraphQL failures', () => {
    expect(isUnsupportedPullRequestFieldError(new Error('rate limit exceeded'))).toBe(false)
  })

  test('un error transitorio que solo NOMBRA el campo no lo da por inexistente', () => {
    const err = new Error(
      'GitHub GraphQL errors: Something went wrong while executing your query. ' +
        'This may be the result of a timeout (path: closedByPullRequestsReferences)',
    )
    expect(isUnsupportedPullRequestFieldError(err)).toBe(false)
  })

  test('reconoce también el fraseo "Undefined field"', () => {
    const err = new Error(
      "GitHub GraphQL errors: Undefined field 'closedByPullRequestsReferences' on type 'Issue'",
    )
    expect(isUnsupportedPullRequestFieldError(err)).toBe(true)
  })

  test('the selection asks for both halves while the field is supported', () => {
    const sel = issueDevLinksSelection()
    expect(sel).toContain('linkedBranches(first: 5)')
    expect(sel).toContain('closedByPullRequestsReferences')
  })
})

describe('CI del PR', () => {
  const withRollup = (state: string | null) =>
    mapDevLinks(
      {
        closedByPullRequestsReferences: {
          nodes: [
            {
              number: 1,
              url: 'u1',
              state: 'OPEN',
              isDraft: false,
              commits: { nodes: [{ commit: { statusCheckRollup: state ? { state } : null } }] },
            },
          ],
        },
      },
      'ia-flow',
    ).pullRequests[0]

  test('mapea statusCheckRollup.state a minúsculas', () => {
    expect(withRollup('SUCCESS').ci).toBe('success')
    expect(withRollup('FAILURE').ci).toBe('failure')
    expect(withRollup('PENDING').ci).toBe('pending')
  })

  // Ausente ≠ pending: el PR no tiene checks configurados.
  test('sin rollup el campo queda ausente, no "pending"', () => {
    expect(withRollup(null).ci).toBeUndefined()
    expect(
      mapDevLinks(
        {
          closedByPullRequestsReferences: {
            nodes: [{ number: 1, url: 'u1', state: 'OPEN', isDraft: false }],
          },
        },
        'ia-flow',
      ).pullRequests[0].ci,
    ).toBeUndefined()
  })

  test('un estado desconocido se descarta en vez de propagarse', () => {
    expect(withRollup('SOMETHING_NEW').ci).toBeUndefined()
  })

  test('la selección pide el rollup del último commit', () => {
    expect(issueDevLinksSelection()).toContain('statusCheckRollup')
  })
})

describe('isCiFinished', () => {
  test('terminado: cualquier resultado, incluido el rojo', () => {
    expect(isCiFinished({ ci: 'success' })).toBe(true)
    expect(isCiFinished({ ci: 'failure' })).toBe(true)
    expect(isCiFinished({ ci: 'error' })).toBe(true)
  })

  test('corriendo: pending y expected', () => {
    expect(isCiFinished({ ci: 'pending' })).toBe(false)
    expect(isCiFinished({ ci: 'expected' })).toBe(false)
  })

  // Un repo sin CI no puede quedar con el botón apagado para siempre.
  test('un PR sin checks cuenta como terminado', () => {
    expect(isCiFinished({})).toBe(true)
  })
})

describe('fetchPullRequestDiff', () => {
  const originalFetch = globalThis.fetch

  beforeAll(() => {
    process.env.GITHUB_TOKEN = 'test-token'
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function stubDiffFetch(body: string): { url?: string; accept?: string } {
    const call: { url?: string; accept?: string } = {}
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      call.url = url
      call.accept = (init?.headers as Record<string, string>)?.Accept
      return new Response(body, { status: 200 })
    }) as unknown as typeof fetch
    return call
  }

  test('pide el diff con el Accept header de GitHub, no JSON', async () => {
    const call = stubDiffFetch('diff --git a/x.ts b/x.ts\n+added line\n')
    const diff = await fetchPullRequestDiff('ia-flow', 'ia-flow', 42)
    expect(diff).toBe('diff --git a/x.ts b/x.ts\n+added line\n')
    expect(call.url).toBe('https://api.github.com/repos/ia-flow/ia-flow/pulls/42')
    expect(call.accept).toBe('application/vnd.github.v3.diff')
  })

  test('un diff corto no se recorta', async () => {
    stubDiffFetch('un diff chico')
    const diff = await fetchPullRequestDiff('o', 'r', 1)
    expect(diff).toBe('un diff chico')
  })

  test('un diff más grande que el tope se recorta y avisa cuánto quedó afuera', async () => {
    const big = 'x'.repeat(PR_DIFF_MAX_CHARS + 500)
    stubDiffFetch(big)
    const diff = await fetchPullRequestDiff('o', 'r', 1)
    expect(diff.startsWith('x'.repeat(PR_DIFF_MAX_CHARS))).toBe(true)
    expect(diff).toContain('diff truncado')
    expect(diff).toContain(String(big.length))
    expect(diff.length).toBeGreaterThan(PR_DIFF_MAX_CHARS)
    expect(diff.length).toBeLessThan(big.length)
  })
})
