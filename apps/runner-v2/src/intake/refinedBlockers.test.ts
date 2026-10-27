import { describe, expect, it } from 'bun:test'
import type { DomainEvent, PipelineExecutionContext } from '@ia-flow/agent-engine'
import type { EventFields, Location } from '@ia-flow/github-webhook'
import type { IssueRef } from './parentEvents.js'
import {
  blockersRefined,
  isRefinedStatus,
  type NotifyRefinedPort,
  notifyBlockersRefined,
  type RefinedBlockersPort,
} from './refinedBlockers.js'

const ctx = {} as PipelineExecutionContext
const REFINED = ['Refined', 'Build', 'Review', 'Done']
const ref = (repo: string, number: number): IssueRef => ({ owner: 'la-haus', repo, number })
const url = (repo: string, number: number) => `https://github.com/la-haus/${repo}/issues/${number}`
const key = (r: IssueRef) => `${r.owner}/${r.repo}#${r.number}`

/** Un board en memoria: el status de cada card y lo que bloquea cada issue. */
function board(
  statuses: Record<string, string>,
  blocking: Record<string, IssueRef[]> = {},
): RefinedBlockersPort {
  return {
    statusOf: async (r) => statuses[key(r)],
    dependents: async (r) => blocking[key(r)] ?? [],
  }
}

describe('isRefinedStatus', () => {
  it('compara sin distinguir mayúsculas', () => {
    expect(isRefinedStatus('refined', REFINED)).toBe(true)
    expect(isRefinedStatus('Refine', REFINED)).toBe(false)
    expect(isRefinedStatus(undefined, REFINED)).toBe(false)
  })
})

describe('blockersRefined', () => {
  const task = ref('web', 10)

  it('sin prerrequisitos abiertos, está refinado y no lee nada', async () => {
    const port: RefinedBlockersPort = {
      statusOf: () => Promise.reject(new Error('no debería leer')),
      dependents: () => Promise.reject(new Error('no debería leer')),
    }
    expect(await blockersRefined(port, task, [], REFINED)).toEqual({
      refined: true,
      waiting: [],
      cycles: [],
    })
  })

  it('espera mientras un prerrequisito sigue en Refine', async () => {
    const port = board({ 'la-haus/api#1': 'Refined', 'la-haus/api#2': 'Refine' })
    const result = await blockersRefined(port, task, [url('api', 1), url('api', 2)], REFINED)
    expect(result).toEqual({ refined: false, waiting: ['la-haus/api#2'], cycles: [] })
  })

  it('un prerrequisito ya construido o en Review cuenta como refinado', async () => {
    const port = board({ 'la-haus/api#1': 'Build', 'la-haus/api#2': 'Review' })
    const result = await blockersRefined(port, task, [url('api', 1), url('api', 2)], REFINED)
    expect(result.refined).toBe(true)
  })

  it('un prerrequisito sin card en el board no está refinado', async () => {
    const result = await blockersRefined(board({}), task, [url('api', 1)], REFINED)
    expect(result).toEqual({ refined: false, waiting: ['la-haus/api#1'], cycles: [] })
  })

  it('el que se acaba de mover cuenta como refinado aunque el board no lo refleje', async () => {
    const port = board({ 'la-haus/api#1': 'Refine' })
    const result = await blockersRefined(port, task, [url('api', 1)], REFINED, ref('api', 1))
    expect(result.refined).toBe(true)
  })

  it('un ciclo directo no traba: el blocker que también espera a la task no cuenta', async () => {
    const port = board({ 'la-haus/api#1': 'Refine' }, { 'la-haus/web#10': [ref('api', 1)] })
    const result = await blockersRefined(port, task, [url('api', 1)], REFINED)
    expect(result).toEqual({ refined: true, waiting: [], cycles: ['la-haus/api#1'] })
  })

  it('una URL que no es de un issue sigue esperando', async () => {
    const odd = 'https://example.com/otra-cosa'
    const result = await blockersRefined(board({}), task, [odd], REFINED)
    expect(result).toEqual({ refined: false, waiting: [odd], cycles: [] })
  })
})

describe('notifyBlockersRefined', () => {
  const statusChange = (to: string): Location => ({
    owner: 'la-haus',
    repo: 'api',
    number: 1,
    emit: 'issue.status_changed',
    extra: { from: 'Refine', to },
  })

  /** Un puerto que registra lo que publica; `waiting` son las tasks que todavía esperan a otro. */
  function port(dependents: IssueRef[], waiting: string[] = []) {
    const published: Array<{ task: string; fields: EventFields; blocker: string }> = []
    const p: NotifyRefinedPort = {
      dependents: async () => dependents,
      publish: async (_ctx, task, fields, options) => {
        if (waiting.includes(key(task))) return { skip: `${key(task)} espera a otro` }
        published.push({ task: key(task), fields, blocker: key(options.refinedBlocker) })
        return { scope: { issue: key(task) } } as unknown as DomainEvent<unknown>
      },
    }
    return { p, published }
  }

  const movedOf = async () => ref('api', 1)

  it('al llegar a Refined, avisa a cada dependiente que ya no espera a otro', async () => {
    const { p, published } = port([ref('web', 10), ref('web', 11)], ['la-haus/web#11'])
    const result = await notifyBlockersRefined(p, ctx, statusChange('Refined'), movedOf, REFINED)
    expect(result).toEqual({ emitted: ['la-haus/web#10'] })
    expect(published).toEqual([
      {
        task: 'la-haus/web#10',
        fields: {
          emit: 'issue.blockers_refined',
          extra: { blocker: 'la-haus/api#1', to: 'Refined' },
        },
        blocker: 'la-haus/api#1',
      },
    ])
  })

  it('un cambio a una columna que no es refinada no avisa', async () => {
    const { p, published } = port([ref('web', 10)])
    const result = await notifyBlockersRefined(p, ctx, statusChange('Refine'), movedOf, REFINED)
    expect('skipped' in result).toBe(true)
    expect(published).toEqual([])
  })

  it('un evento que no es un cambio de columna no avisa', async () => {
    const { p } = port([ref('web', 10)])
    const location: Location = { ...statusChange('Refined'), emit: 'issue.labeled' } as Location
    const result = await notifyBlockersRefined(p, ctx, location, movedOf, REFINED)
    expect(result).toEqual({ skipped: 'issue.labeled no es un cambio de columna' })
  })

  it('sin dependientes que queden listos, lo dice', async () => {
    const { p } = port([])
    const result = await notifyBlockersRefined(p, ctx, statusChange('Build'), movedOf, REFINED)
    expect(result).toEqual({
      skipped: 'la-haus/api#1 no deja ninguna task con sus prerrequisitos refinados',
    })
  })
})
