import { describe, expect, it } from 'vitest'
import type { GithubTaskReader } from '../../task/GithubTaskReader.js'
import { ProjectsV2Intake } from '../ProjectsV2Intake.js'

const board = { owner: 'la-haus', number: 119 }

/** Un reader de mentira: lo que GitHub devuelve de un issue y de un item. */
function reader(parts: Partial<Pick<GithubTaskReader, 'itemsOfIssue' | 'issueOfItem'>>) {
  return parts as unknown as GithubTaskReader
}

describe('ProjectsV2Intake.cardOf', () => {
  it('the card of the issue on this board, with its status and type', async () => {
    const intake = new ProjectsV2Intake(
      reader({
        itemsOfIssue: async () => [
          {
            id: 'PVTI_1',
            project: { number: 119, owner: { login: 'La-Haus' } },
            fieldValues: {
              nodes: [
                { name: 'Build', field: { name: 'Status' } },
                { name: 'Functional', field: { name: 'Task Type' } },
              ],
            },
          },
        ],
      }),
      board,
    )
    expect(await intake.cardOf({ owner: 'la-haus', repo: 'subscriptions', number: 7 })).toEqual({
      itemId: 'PVTI_1',
      status: 'Build',
      type: 'functional',
    })
  })

  it('undefined when the issue is only on another board', async () => {
    const intake = new ProjectsV2Intake(
      reader({
        itemsOfIssue: async () => [
          { id: 'PVTI_9', project: { number: 3, owner: { login: 'la-haus' } } },
        ],
      }),
      board,
    )
    expect(await intake.cardOf({ owner: 'la-haus', repo: 'r', number: 1 })).toBeUndefined()
  })
})

describe('ProjectsV2Intake.issueOfItem', () => {
  const found = (project: { owner: string; number: number }) =>
    reader({
      issueOfItem: async () =>
        ({ board: project, owner: 'la-haus', repo: 'subscriptions', number: 7 }) as never,
    })

  it('the issue behind an item of this board', async () => {
    const intake = new ProjectsV2Intake(found(board), board)
    expect(await intake.issueOfItem('PVTI_1')).toEqual({
      issue: { owner: 'la-haus', repo: 'subscriptions', number: 7 },
    })
  })

  it('says which board the item is on when it is not this one', async () => {
    const intake = new ProjectsV2Intake(found({ owner: 'la-haus', number: 3 }), board)
    expect(await intake.issueOfItem('PVTI_1')).toEqual({ skipped: 'item del board la-haus#3' })
  })

  it('says it could not read the item (a draft, a PR)', async () => {
    const intake = new ProjectsV2Intake(
      reader({ issueOfItem: async () => undefined as never }),
      board,
    )
    expect(await intake.issueOfItem('PVTI_x')).toEqual({
      skipped: 'no se pudo leer el item PVTI_x',
    })
  })
})
