import { describe, expect, it } from 'vitest'
import { formatComments, latestCheckRuns, rollupCi, taskNews, taskTimeline } from '../timeline.js'

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

  it('a queued workflow run with no check-runs yet keeps it pending; a finished one adds nothing', () => {
    const fast = [{ status: 'completed', conclusion: 'success' }]
    expect(rollupCi(fast, [], [{ status: 'completed' }, { status: 'queued' }])).toBe('pending')
    expect(rollupCi(fast, [], [{ status: 'completed' }])).toBe('success')
    expect(rollupCi([], [], [{ status: 'waiting' }])).toBe('pending')
  })

  it('a check counts only by its latest run: a cancelled duplicate superseded by a success is green', () => {
    // El caso de lh-seller-v2-frontend#4377: dos "Semantic Pull Requests" en el mismo commit.
    const runs = [
      {
        id: 115992292789,
        name: 'Semantic Pull Requests',
        status: 'completed',
        conclusion: 'success',
      },
      { id: 115991759046, name: 'Lint', status: 'completed', conclusion: 'success' },
      {
        id: 115991758407,
        name: 'Semantic Pull Requests',
        status: 'completed',
        conclusion: 'cancelled',
      },
    ]
    expect(rollupCi(runs, [])).toBe('success')
    // Al revés —el último es el rojo—, sigue rojo.
    expect(
      rollupCi(
        [
          { id: 1, name: 'Lint', status: 'completed', conclusion: 'success' },
          { id: 2, name: 'Lint', status: 'completed', conclusion: 'failure' },
        ],
        [],
      ),
    ).toBe('failure')
  })

  it('a cancelled latest run leaves the CI pending, and a real red still wins over it', () => {
    const cancelled = { id: 2, name: 'Tests', status: 'completed', conclusion: 'cancelled' }
    const lint = { id: 1, name: 'Lint', status: 'completed', conclusion: 'success' }
    expect(rollupCi([lint, cancelled], [])).toBe('pending')
    expect(
      rollupCi(
        [cancelled, { id: 3, name: 'Lint', status: 'completed', conclusion: 'failure' }],
        [],
      ),
    ).toBe('failure')
    // Relanzado: la corrida nueva lo reemplaza.
    expect(
      rollupCi(
        [cancelled, { id: 4, name: 'Tests', status: 'completed', conclusion: 'success' }],
        [],
      ),
    ).toBe('success')
  })
})

describe('latestCheckRuns', () => {
  it('keeps the highest id per name, in order, and every run without name or id', () => {
    const runs = [
      { id: 3, name: 'Lint' },
      { id: 1, name: 'Tests' },
      { id: 5, name: 'Tests' },
      { name: 'legacy' },
      { name: 'legacy' },
    ]
    expect(latestCheckRuns(runs)).toEqual([
      { id: 3, name: 'Lint' },
      { id: 5, name: 'Tests' },
      { name: 'legacy' },
      { name: 'legacy' },
    ])
  })
})

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

describe('taskTimeline', () => {
  it('merges the issue and the open PR: comments, unresolved threads and reviews', () => {
    const text = taskTimeline({
      issueComments: [comment('falta paginar', '2026-09-25T10:00:00Z')],
      pr: 12,
      prComments: [comment('listo para revisar', '2026-09-25T11:00:00Z', 'bot')],
      threads: [
        thread(
          'PRRT_abierto',
          false,
          ['rev', 'esto rompe', '2026-09-25T12:00:00Z'],
          ['bot', 'lo miro', '2026-09-25T12:05:00Z'],
        ),
        thread('PRRT_cerrado', true, ['rev', 'ya está', '2026-09-25T11:30:00Z']),
      ],
      reviews: [
        {
          body: '',
          submitted_at: '2026-09-25T12:01:00Z',
          user: { login: 'rev' },
          state: 'CHANGES_REQUESTED',
        },
      ],
    })
    expect(text).toContain('· issue · julian]\nfalta paginar')
    expect(text).toContain('· PR #12 · bot]\nlisto para revisar')
    // El hilo sin resolver, entero y con su id para responderlo o resolverlo; el resuelto no está.
    expect(text).toContain(
      '· PR #12 · review · a.ts:3 · thread PRRT_abierto · rev]\n**rev:** esto rompe\n\n**bot:** lo miro',
    )
    expect(text).not.toContain('PRRT_cerrado')
    // Una review sin body no agrega un bloque vacío.
    expect(text.match(/^\[/gm)).toHaveLength(3)
  })

  it('without an open PR, only the issue comments', () => {
    const text = taskTimeline({
      issueComments: [comment('hola', '2026-09-25T10:00:00Z')],
      prComments: [comment('del PR', '2026-09-25T11:00:00Z')],
    })
    expect(text).toContain('hola')
    expect(text).not.toContain('del PR')
  })
})

describe('taskNews', () => {
  const comment = (at: string, body: string) => ({
    created_at: at,
    body,
    user: { login: 'julian' },
  })
  const input = {
    issueComments: [
      comment('2026-10-27T10:00:00Z', 'viejo'),
      comment('2026-10-27T12:00:00Z', 'nuevo del issue'),
    ],
    pr: 9,
    prComments: [comment('2026-10-27T13:00:00Z', 'nuevo del PR')],
  }

  it('sólo trae lo posterior a la fecha, del issue y del PR', () => {
    const news = taskNews(input, '2026-10-27T11:00:00Z')
    expect(news).toContain('nuevo del issue')
    expect(news).toContain('nuevo del PR')
    expect(news).not.toContain('viejo')
  })

  it('sin nada posterior, vacío', () => {
    expect(taskNews(input, '2026-10-28T00:00:00Z')).toBe(taskTimeline({}))
  })

  it('una fecha que no se entiende trae todo, como taskTimeline', () => {
    expect(taskNews(input, 'nunca')).toBe(taskTimeline(input))
  })
})
