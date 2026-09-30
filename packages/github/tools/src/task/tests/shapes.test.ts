/** Lo puro de `resolve_task` (`intake/task.ts`). */
import { describe, expect, it } from 'vitest'
import { boardItem, issueRefs, openPr } from '../shapes.js'

describe('boardItem', () => {
  const item = (number: number, owner: string, fields: Array<[string, string]>) => ({
    id: `PVTI_${number}`,
    project: { number, owner: { login: owner } },
    fieldValues: {
      nodes: [...fields.map(([field, name]) => ({ name, field: { name: field } })), {}],
    },
  })

  it('picks the item of the board and reads Status and Task Type (technical by default)', () => {
    const items = [
      item(1, 'la-haus', [['Status', 'Done']]),
      item(119, 'La-Haus', [
        ['Status', 'Build'],
        ['Task Type', 'Functional'],
      ]),
    ]
    expect(boardItem(items, { owner: 'la-haus', number: 119 })).toEqual({
      itemId: 'PVTI_119',
      status: 'Build',
      type: 'functional',
    })
    expect(boardItem([item(119, 'la-haus', [])], { owner: 'la-haus', number: 119 })?.type).toBe(
      'technical',
    )
    expect(boardItem(items, { owner: 'la-haus', number: 7 })).toBeUndefined()
    expect(boardItem(undefined, { owner: 'la-haus', number: 7 })).toBeUndefined()
  })
})

describe('issueRefs', () => {
  it('keeps the open ones of the catalog repos, with their repo from repository_url', () => {
    const api = 'https://api.github.com/repos'
    expect(
      issueRefs(
        [
          { number: 9, state: 'open', repository_url: `${api}/la-haus/subscriptions` },
          { number: 10, state: 'closed', repository_url: `${api}/la-haus/subscriptions` },
          { number: 11, state: 'open', repository_url: `${api}/la-haus/otro` },
          { number: 12, state: 'open', repository_url: `${api}/La-Haus/Frontend` },
        ],
        ['la-haus/subscriptions', 'la-haus/frontend'],
      ),
    ).toEqual([
      { owner: 'la-haus', repo: 'subscriptions', number: 9 },
      { owner: 'La-Haus', repo: 'Frontend', number: 12 },
    ])
  })
})

describe('openPr', () => {
  const pr = (number: number, state = 'open') => ({
    number,
    state,
    html_url: `https://github.com/x/pull/${number}`,
    title: `PR ${number}`,
    user: { login: 'bot' },
    head: { sha: `sha${number}`, ref: 'ia-flow-local/7' },
    base: { ref: 'main' },
  })

  it('is the PR as `task.pr` while it is open, whatever its branch is called', () => {
    expect(openPr({ ...pr(12), head: { sha: 'sha12', ref: 'feat/auth0' } })?.headRef).toBe(
      'feat/auth0',
    )
    expect(openPr(pr(12))).toEqual({
      number: 12,
      url: 'https://github.com/x/pull/12',
      headSha: 'sha12',
      title: 'PR 12',
      author: 'bot',
      headRef: 'ia-flow-local/7',
      baseRef: 'main',
    })
    expect(openPr(pr(12, 'closed'))).toBeUndefined()
  })
})
