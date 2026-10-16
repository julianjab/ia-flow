import type { ExecutionAgent } from '@ia-flow/shared'
import { describe, expect, it } from 'vitest'
import { actingAgent, idleText, lanesOf, whoOf } from '@/features/inbox/queue/agents'
import { runningOf } from '@/features/inbox/queue/build'
import { detailOf } from '@/features/inbox/queue/entries'
import { verbOf } from '@/features/inbox/queue/kinds'
import { execution, item } from '@/features/inbox/test/fixtures'

const NOW = Date.parse('2026-01-01T10:12:00.000Z')

const agent = (
  agent_id: string,
  state: ExecutionAgent['state'],
  over: Partial<ExecutionAgent> = {},
) => ({
  agent_id,
  state,
  started_at: '2026-01-01T10:00:00.000Z',
  last_step_at: '2026-01-01T10:10:00.000Z',
  ...over,
})

/** El caso que lo motivó: la review corre `reviewer` + `e2e-visual-qa` en UNA ejecución. */
const review = (agents: ExecutionAgent[]) =>
  execution({ pipeline_id: 'review', agent_id: 'reviewer', agents })

describe('idleText', () => {
  it('dice cuánto hace del último paso, corto', () => {
    expect(idleText(12)).toBe('ahora')
    expect(idleText(125)).toBe('hace 2 min')
    expect(idleText(3 * 3600 + 10)).toBe('hace 3 h')
  })

  it('sin dato (o uno roto), nada', () => {
    expect(idleText(undefined)).toBeUndefined()
    expect(idleText(-1)).toBeUndefined()
    expect(idleText(Number.NaN)).toBeUndefined()
  })
})

describe('lanesOf', () => {
  it('con uno solo, o sin agents, no hay carriles: se muestra el agent_id de siempre', () => {
    expect(lanesOf(undefined)).toEqual([])
    expect(lanesOf(execution())).toEqual([])
    expect(
      lanesOf(execution({ agents: [agent('implementer', 'running', { idle_seconds: 90 })] })),
    ).toEqual([])
  })

  it('con varios, cada uno con su glifo, su tono y, el que corre, cuánto lleva quieto', () => {
    const lanes = lanesOf(
      review([agent('reviewer', 'done'), agent('e2e-visual-qa', 'running', { idle_seconds: 130 })]),
    )
    expect(lanes).toEqual([
      { id: 'reviewer', state: 'done', glyph: '✓', tone: 'ok', label: 'terminó' },
      {
        id: 'e2e-visual-qa',
        state: 'running',
        glyph: '●',
        tone: 'live',
        label: 'corriendo',
        idle: 'hace 2 min',
      },
    ])
  })

  it('falló e interrumpido llevan su tono; el idle sólo va en el que corre', () => {
    const lanes = lanesOf(
      review([
        agent('reviewer', 'failed', { idle_seconds: 600 }),
        agent('e2e-visual-qa', 'interrupted'),
        agent('qa', 'unfinished'),
        agent('judge', 'waiting'),
      ]),
    )
    expect(lanes.map((l) => [l.id, l.glyph, l.tone])).toEqual([
      ['reviewer', '✕', 'bad'],
      ['e2e-visual-qa', '○', 'warn'],
      ['qa', '○', 'dim'],
      ['judge', '‖', 'warn'],
    ])
    expect(lanes.every((l) => l.idle === undefined)).toBe(true)
  })
})

describe('actingAgent', () => {
  it('sin varios, el agent_id', () => {
    expect(actingAgent(execution())).toBe('implementer')
    expect(actingAgent(undefined)).toBeUndefined()
  })

  it('con varios, el que espera; si no, el que falló; si no se sabe, el último que cerró', () => {
    expect(
      actingAgent(review([agent('reviewer', 'done'), agent('e2e-visual-qa', 'waiting')])),
    ).toBe('e2e-visual-qa')
    expect(actingAgent(review([agent('reviewer', 'done'), agent('e2e-visual-qa', 'failed')]))).toBe(
      'e2e-visual-qa',
    )
    expect(
      actingAgent(review([agent('reviewer', 'failed'), agent('e2e-visual-qa', 'failed')])),
    ).toBe('reviewer')
  })

  it('el verbo y quién lo dice nombran al que espera, no al último que cerró', () => {
    const doubt = item({
      kind: 'doubt',
      agent_said: '¿Qué viewport?',
      execution: review([agent('reviewer', 'done'), agent('e2e-visual-qa', 'waiting')]),
    })
    expect(verbOf(doubt)).toBe('Responder al e2e-visual-qa')
    expect(detailOf(doubt).saidBy).toBe('El e2e-visual-qa dice')
  })
})

describe('whoOf', () => {
  it('uno solo: pipeline → agente, como siempre', () => {
    expect(whoOf(execution())).toBe('build → implementer')
    expect(whoOf(execution({ agent_id: undefined }))).toBe('build')
  })

  it('varios: los que siguen en vuelo, no el último que cerró', () => {
    expect(whoOf(review([agent('reviewer', 'running'), agent('e2e-visual-qa', 'running')]))).toBe(
      'review → reviewer + e2e-visual-qa',
    )
    expect(whoOf(review([agent('reviewer', 'done'), agent('e2e-visual-qa', 'running')]))).toBe(
      'review → e2e-visual-qa',
    )
  })
})

describe('runningOf', () => {
  it('lleva los agentes sólo si corre más de uno', () => {
    const single = item({
      ref: 'o/r#1',
      group: 'run',
      execution: execution({ agents: [agent('implementer', 'running')] }),
    })
    const parallel = item({
      ref: 'o/r#2',
      group: 'run',
      execution: review([agent('reviewer', 'done'), agent('e2e-visual-qa', 'running')]),
    })
    const [a, b] = runningOf([single, parallel], NOW)
    expect(a?.agent).toBe('implementer')
    expect(a?.agents).toBeUndefined()
    expect(b?.agents?.map((x) => x.agent_id)).toEqual(['reviewer', 'e2e-visual-qa'])
  })
})
