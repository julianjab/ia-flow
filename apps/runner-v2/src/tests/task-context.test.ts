import { describe, expect, it } from 'bun:test'
import type { GithubClient } from '@ia-tools/github-api'
import {
  formatComments,
  GithubTaskContextReader,
  rollupCi,
} from '../actions/intake/task-context.js'

describe('formatComments', () => {
  it('orders by date and heads each block with date · origin · author, like ia-flow', () => {
    const text = formatComments([
      {
        createdAt: '2026-09-25T12:00:00Z',
        origin: 'PR #12 · review · src/a.ts:3',
        author: 'rev',
        body: 'ojo acá',
      },
      {
        createdAt: '2026-09-25T10:00:00Z',
        origin: 'issue',
        author: 'julian',
        body: ' falta paginar ',
      },
      { createdAt: '2026-09-25T11:00:00Z', origin: 'issue', body: '   ' },
    ])
    expect(text.split('\n\n')).toHaveLength(2)
    expect(text).toMatch(
      /^\[2026-09-25 \d\d:00 · issue · julian\]\nfalta paginar\n\n\[.* · PR #12 · review · src\/a.ts:3 · rev\]\nojo acá$/,
    )
  })
})

describe('rollupCi', () => {
  it('red wins, then pending; nothing is empty', () => {
    expect(rollupCi([{ status: 'completed', conclusion: 'success' }], ['failure'])).toBe('failure')
    expect(
      rollupCi(
        [
          { status: 'in_progress', conclusion: null },
          { status: 'completed', conclusion: 'success' },
        ],
        [],
      ),
    ).toBe('pending')
    expect(rollupCi([{ status: 'completed', conclusion: 'skipped' }], ['success'])).toBe('success')
    expect(rollupCi([], [])).toBe('')
  })
})

/** Un `GithubClient` que responde por path (REST) y devuelve `graphql` tal cual — sin red. */
function fakeClient(routes: Record<string, unknown>, graphql: unknown = {}): GithubClient {
  return {
    requestJson: async (path: string) => {
      const hit = Object.entries(routes).find(([prefix]) => path.startsWith(prefix))
      if (!hit) throw new Error(`ruta no simulada: ${path}`)
      return hit[1]
    },
    graphql: async () => graphql,
  } as unknown as GithubClient
}

const base = '/repos/la-haus/subscriptions'
const comment = (body: string, at: string, login = 'julian') => ({
  body,
  created_at: at,
  user: { login },
})
const thread = (id: string, isResolved: boolean, ...messages: Array<[string, string, string]>) => ({
  id,
  isResolved,
  path: 'a.ts',
  line: 3,
  comments: {
    nodes: messages.map(([login, body, createdAt]) => ({ body, createdAt, author: { login } })),
  },
})

describe('GithubTaskContextReader', () => {
  it('finds the open PR from the task branch and merges issue + PR timeline, CI and blockers', async () => {
    const reader = new GithubTaskContextReader(
      fakeClient(
        {
          [`${base}/issues/7/comments`]: [comment('falta paginar', '2026-09-25T10:00:00Z')],
          [`${base}/issues/7/dependencies/blocked_by`]: [
            { number: 3, title: 'migrar tabla', state: 'open', html_url: 'https://github.com/x/3' },
            { number: 2, title: 'ya hecho', state: 'closed', html_url: 'https://github.com/x/2' },
          ],
          [`${base}/pulls?state=open&head=`]: [
            {
              number: 12,
              html_url: 'https://github.com/la-haus/subscriptions/pull/12',
              state: 'open',
              head: { sha: 'abc' },
            },
          ],
          [`${base}/issues/12/comments`]: [
            comment('listo para revisar', '2026-09-25T11:00:00Z', 'bot'),
          ],
          [`${base}/pulls/12/reviews`]: [
            {
              body: '',
              submitted_at: '2026-09-25T12:01:00Z',
              user: { login: 'rev' },
              state: 'CHANGES_REQUESTED',
            },
          ],
          [`${base}/commits/abc/check-runs`]: {
            check_runs: [{ status: 'completed', conclusion: 'failure' }],
          },
          [`${base}/commits/abc/status`]: { statuses: [] },
        },
        {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  thread(
                    'PRRT_abierto',
                    false,
                    ['rev', 'esto rompe', '2026-09-25T12:00:00Z'],
                    ['bot', 'lo miro', '2026-09-25T12:05:00Z'],
                  ),
                  thread('PRRT_cerrado', true, ['rev', 'ya está', '2026-09-25T11:30:00Z']),
                ],
              },
            },
          },
        },
      ),
    )
    const context = await reader.load({
      owner: 'la-haus',
      repo: 'subscriptions',
      number: 7,
      branch: 'ia-flow/7',
    })
    expect(context.pr).toEqual({
      number: 12,
      url: 'https://github.com/la-haus/subscriptions/pull/12',
    })
    expect(context.ci).toBe('failure')
    expect(context.blockers).toEqual([
      { number: 3, title: 'migrar tabla', url: 'https://github.com/x/3' },
    ])
    expect(context.comments).toContain('· issue · julian]\nfalta paginar')
    expect(context.comments).toContain('· PR #12 · bot]\nlisto para revisar')
    // El hilo sin resolver, entero y con su id para responderlo o resolverlo; el resuelto no está.
    expect(context.comments).toContain(
      '· PR #12 · review · a.ts:3 · thread PRRT_abierto · rev]\n**rev:** esto rompe\n\n**bot:** lo miro',
    )
    expect(context.comments).not.toContain('PRRT_cerrado')
    // Una review sin body no agrega un bloque vacío.
    expect(context.comments.match(/^\[/gm)).toHaveLength(3)
  })

  it('without an open PR, returns only the issue comments, no CI and its blockers', async () => {
    const reader = new GithubTaskContextReader(
      fakeClient({
        [`${base}/issues/7/comments`]: [comment('hola', '2026-09-25T10:00:00Z')],
        [`${base}/issues/7/dependencies/blocked_by`]: [],
        [`${base}/pulls?state=open&head=`]: [],
      }),
    )
    const context = await reader.load({
      owner: 'la-haus',
      repo: 'subscriptions',
      number: 7,
      branch: 'ia-flow/7',
    })
    expect(context).toEqual({ comments: expect.stringContaining('hola'), ci: '', blockers: [] })
  })
})
