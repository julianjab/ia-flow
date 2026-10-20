import { describe, expect, it } from 'vitest'
import { RECENT_LIMIT, recentOf } from '@/features/inbox/queue/recent'
import { execution } from '@/features/inbox/test/fixtures'

const NOW = Date.parse('2026-01-01T12:00:00.000Z')
const at = (min: number) => new Date(NOW - min * 60_000).toISOString()
const card = (n: number, run?: ReturnType<typeof execution>) => ({
  ref: `acme/api#${n}`,
  title: `Tarea ${n}`,
  url: `https://github.com/acme/api/issues/${n}`,
  ...(run ? { run } : {}),
})

describe('recentOf', () => {
  it('lista las que cerraron, de la más nueva a la más vieja, con quién y hace cuánto', () => {
    const runs = recentOf(
      [
        card(1, execution({ status: 'done', agent_id: 'reviewer', closed_at: at(90) })),
        card(2, execution({ status: 'failed', agent_id: 'implementer', closed_at: at(5) })),
      ],
      NOW,
    )
    expect(runs.map((r) => [r.short, r.status, r.agent, r.age.text])).toEqual([
      ['api#2', 'failed', 'implementer', '5 min'],
      ['api#1', 'done', 'reviewer', '1 h'],
    ])
  })

  it('deja afuera lo que sigue vivo y lo que nunca corrió', () => {
    const runs = recentOf(
      [
        card(1, execution({ status: 'running' })),
        card(2, execution({ status: 'paused', closed_at: at(1) })),
        card(3),
        card(4, execution({ status: 'superseded', closed_at: at(2) })),
      ],
      NOW,
    )
    expect(runs.map((r) => r.ref)).toEqual(['acme/api#4'])
  })

  it('la salida sólo se dice si no es la de siempre', () => {
    const [blocked, done] = recentOf(
      [
        card(1, execution({ status: 'done', exit: 'blocked', closed_at: at(1) })),
        card(2, execution({ status: 'done', exit: 'done', closed_at: at(2) })),
      ],
      NOW,
    )
    expect(blocked?.exit).toBe('blocked')
    expect(done?.exit).toBeUndefined()
  })

  it('con varios agentes en paralelo nombra la pipeline, no al último que cerró', () => {
    const agent = { state: 'done' as const, started_at: at(9), last_step_at: at(2) }
    const [run] = recentOf(
      [
        card(
          1,
          execution({
            status: 'done',
            pipeline_id: 'review',
            agent_id: 'e2e',
            closed_at: at(1),
            agents: [
              { ...agent, agent_id: 'reviewer' },
              { ...agent, agent_id: 'e2e' },
            ],
          }),
        ),
      ],
      NOW,
    )
    expect(run?.agent).toBe('review')
  })

  it('es un vistazo: corta en RECENT_LIMIT', () => {
    const many = Array.from({ length: RECENT_LIMIT + 3 }, (_, i) =>
      card(i, execution({ status: 'done', closed_at: at(i) })),
    )
    expect(recentOf(many, NOW)).toHaveLength(RECENT_LIMIT)
  })
})
