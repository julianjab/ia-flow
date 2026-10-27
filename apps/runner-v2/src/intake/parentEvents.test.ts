import { describe, expect, it } from 'bun:test'
import type { DomainEvent, PipelineExecutionContext } from '@ia-flow/agent-engine'
import type { EventFields, Location } from '@ia-flow/github-webhook'
import { type IssueRef, type ParentPort, statusToParent } from './parentEvents.js'

const ctx = {} as PipelineExecutionContext
const child: IssueRef = { owner: 'la-haus', repo: 'api', number: 2041 }
const epic: IssueRef = { owner: 'la-haus', repo: 'api', number: 1762 }

const moved = (to: string): Location => ({
  owner: 'la-haus',
  repo: 'api',
  number: 2041,
  emit: 'issue.status_changed',
  extra: { from: 'Refine', to },
})

function port(withText = true) {
  const published: EventFields[] = []
  const reads: IssueRef[] = []
  const p: ParentPort = {
    projectId: 'p',
    parentOf: async () => epic,
    inCatalog: () => true,
    ...(withText
      ? {
          childText: async (c: IssueRef) => {
            reads.push(c)
            return { title: 'API del override', body: '## PRD\n...' }
          },
        }
      : {}),
    publish: async (_ctx, _task, fields) => {
      published.push(fields)
      return { scope: { issue: 'la-haus/api#1762' } } as unknown as DomainEvent<unknown>
    },
  }
  return { p, published, reads }
}

describe('statusToParent — childPrdOn', () => {
  it('al llegar a una columna de childPrdOn, el aviso trae el título y el PRD del hijo', async () => {
    const { p, published } = port()
    await statusToParent(p, ctx, moved('Refined'), async () => child, ['refined'])
    expect(published[0]?.extra).toMatchObject({
      to: 'Refined',
      child: 'la-haus/api#2041',
      childTitle: 'API del override',
      childPrd: '## PRD\n...',
    })
  })

  it('en otra columna, o sin childPrdOn, no lee ni manda el PRD', async () => {
    for (const [to, prdOn] of [
      ['Build', ['Refined']],
      ['Refined', undefined],
    ] as const) {
      const { p, published, reads } = port()
      await statusToParent(p, ctx, moved(to), async () => child, prdOn)
      expect(reads).toEqual([])
      expect(published[0]?.extra).not.toHaveProperty('childPrd')
    }
  })

  it('sin lector del hijo, avisa igual sin el PRD', async () => {
    const { p, published } = port(false)
    await statusToParent(p, ctx, moved('Refined'), async () => child, ['Refined'])
    expect(published[0]?.extra).not.toHaveProperty('childPrd')
  })
})
