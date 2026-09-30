/** Lo puro de `resolve_task` (`intake/task.ts`). */
import { describe, expect, it } from 'bun:test'
import {
  boardItem,
  issueRefs,
  linkedIssue,
  openPr,
} from '../../.config/actions/_lib/intake/task.js'

describe('linkedIssue', () => {
  it('reads the branch with the project prefix, and nothing else', () => {
    expect(linkedIssue('ia-flow-local/42', '', 'ia-flow-local/')).toBe(42)
    expect(linkedIssue('ia-flow/42', '', 'ia-flow-local/')).toBeUndefined()
    expect(linkedIssue('ia-flow/42', 'Closes #9', 'ia-flow-local/')).toBe(9)
  })

  it('prefers the branch, then a closing reference', () => {
    expect(linkedIssue('ia-flow/42', 'Closes #9', 'ia-flow/')).toBe(42)
    expect(linkedIssue('feat/x', 'Implements it.\n\nCloses #9', 'ia-flow/')).toBe(9)
    expect(linkedIssue('feat/x', 'fixes #3', 'ia-flow/')).toBe(3)
    expect(linkedIssue('ia-flow/42-extra', 'mentions #9', 'ia-flow/')).toBeUndefined()
    expect(linkedIssue(undefined, undefined, 'ia-flow/')).toBeUndefined()
  })
})

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

  it('the event PR if still open, otherwise the one open from the task branch', () => {
    expect(openPr(pr(12), [pr(13)])).toEqual({
      number: 12,
      url: 'https://github.com/x/pull/12',
      headSha: 'sha12',
      title: 'PR 12',
      author: 'bot',
      headRef: 'ia-flow-local/7',
      baseRef: 'main',
    })
    expect(openPr(pr(12, 'closed'), undefined)).toBeUndefined()
    expect(openPr(undefined, [pr(13)])?.number).toBe(13)
    expect(openPr(undefined, [])).toBeUndefined()
  })
})
