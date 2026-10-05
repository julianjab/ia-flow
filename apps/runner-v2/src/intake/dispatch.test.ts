import { describe, expect, it } from 'bun:test'
import type { DomainEvent } from '@ia-flow/agent-engine'
import type { MountedRunner } from '../boot.js'
import { simulateIssue } from './dispatch.js'

const target = { owner: 'la-haus', repo: 'subscriptions', number: 1625 }

/** Lo mínimo del runner que usa `simulateIssue`: los boards, GitHub y el engine. */
function fakeRunner(cards: { ref: string; projectId: string }[] = []) {
  const dispatched: DomainEvent[] = []
  const moved: { ref: string; status: string; sender: string }[] = []
  const requested: string[] = []
  const board = {
    cards: async () => cards,
    statusChange: (card: { ref: string }, status: string, sender: string) => {
      moved.push({ ref: card.ref, status, sender })
      return { event: 'projects_v2_item', id: 'sim', payload: { simulated: status } }
    },
  }
  const mounted = {
    boards: { all: () => [board] },
    github: {
      requestJson: async (path: string) => {
        requested.push(path)
        return path.endsWith('/issues/1625')
          ? { number: 1625, title: 'el issue' }
          : { name: 'subscriptions' }
      },
    },
    engine: {
      dispatch: async (event: DomainEvent) => {
        dispatched.push(event)
        return 'ok'
      },
    },
  } as unknown as MountedRunner
  return { mounted, dispatched, moved, requested }
}

describe('simulateIssue (--issue)', () => {
  it('--status: el board de la card arma el webhook de "llegó a esa columna" y entra por el intake', async () => {
    const runner = fakeRunner([{ ref: 'la-haus/subscriptions#1625', projectId: 'lahaus-ai-flow' }])
    await simulateIssue(runner.mounted, target, { status: 'Review' }, 'julian', () => {})

    expect(runner.moved).toEqual([
      { ref: 'la-haus/subscriptions#1625', status: 'Review', sender: 'julian' },
    ])
    expect(runner.dispatched).toHaveLength(1)
    // Crudo, como un delivery: el intake decide la task y qué pipeline corre.
    expect(runner.dispatched[0]?.type).toBe('github.projects_v2_item')
    expect(runner.dispatched[0]?.payload).toEqual({ simulated: 'Review' })
  })

  it('--status de una card que no está en ningún board: falla diciéndolo, sin despachar', async () => {
    const runner = fakeRunner([])
    await expect(
      simulateIssue(runner.mounted, target, { status: 'Review' }, 'x', () => {}),
    ).rejects.toThrow(/no está en ningún board/)
    expect(runner.dispatched).toEqual([])
  })

  it('--label: el `issues` `labeled` de GitHub con el issue y el repo reales, sin tocar GitHub', async () => {
    const runner = fakeRunner()
    await simulateIssue(runner.mounted, target, { label: 'e2e-test' }, 'julian', () => {})

    // Sólo lee: el label no se pone.
    expect(runner.requested.sort()).toEqual([
      '/repos/la-haus/subscriptions',
      '/repos/la-haus/subscriptions/issues/1625',
    ])
    expect(runner.dispatched).toHaveLength(1)
    expect(runner.dispatched[0]?.type).toBe('github.issues')
    expect(runner.dispatched[0]?.payload).toEqual({
      action: 'labeled',
      label: { name: 'e2e-test' },
      issue: { number: 1625, title: 'el issue' },
      repository: { name: 'subscriptions' },
      sender: { login: 'julian' },
    })
    // El scope del delivery: el issue, para la traza.
    expect(runner.dispatched[0]?.scope).toMatchObject({ source: 'webhook' })
  })
})
