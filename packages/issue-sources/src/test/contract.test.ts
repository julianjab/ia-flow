import { describe, expect, test } from 'bun:test'
import type { CreateItemInput, IssueItem, SourceItem } from '../contract.js'
import { defaultToIssueItem, issueItemToTask } from '../contract.js'

describe('issueItemToTask', () => {
  test('maps every IssueItem field onto the Task shape', () => {
    const item: IssueItem = {
      id: 'i1',
      title: 'Title',
      description: 'Desc',
      status: 'Todo',
      type: 'functional',
      repos: ['repo-a'],
      issueNumber: 7,
      issueUrl: 'https://github.com/acme/repo-a/issues/7',
      labels: ['bug'],
      assignees: ['octocat'],
      fields: { Priority: 'High' },
      comments: [{ id: 'c1', body: 'hi', created_at: '2024-01-01T00:00:00Z' }],
      projectId: 'proj-1',
      branch: 'feature/x',
    }

    const task = issueItemToTask(item)

    expect(task.id).toBe('i1')
    expect(task.title).toBe('Title')
    expect(task.description).toBe('Desc')
    expect(task.status).toBe('Todo')
    expect(task.type).toBe('functional')
    expect(task.repos).toEqual(['repo-a'])
    expect(task.issueNumber).toBe(7)
    expect(task.issueUrl).toBe('https://github.com/acme/repo-a/issues/7')
    expect(task.labels).toEqual(['bug'])
    expect(task.assignees).toEqual(['octocat'])
    expect(task.fields).toEqual({ Priority: 'High' })
    expect(task.comments).toEqual(item.comments)
    expect(task.projectId).toBe('proj-1')
    expect(task.branch).toBe('feature/x')
    expect(typeof task.created_at).toBe('string')
  })

  test('preserves an explicit type instead of defaulting it', () => {
    const item: IssueItem = {
      id: 'i2',
      title: 'T',
      description: '',
      status: 'Todo',
      type: 'technical',
      repos: [],
    }
    expect(issueItemToTask(item).type).toBe('technical')
  })

  test('defaults type to "functional" when the source omits it entirely', () => {
    const { type, ...rest } = {
      id: 'i3',
      title: 'T',
      description: '',
      status: 'Todo',
      type: 'functional',
      repos: [],
    }
    const item = rest as IssueItem
    expect(issueItemToTask(item).type).toBe('functional')
  })
})

describe('defaultToIssueItem', () => {
  test('splits comma-separated repos and trims whitespace', () => {
    const source: SourceItem = {
      id: 's1',
      title: 'T',
      status: 'Todo',
      repos: ' repo-a, repo-b ,,',
      meta: { type: 'technical', working: true },
    }
    const item = defaultToIssueItem(source)
    expect(item.repos).toEqual(['repo-a', 'repo-b'])
    expect(item.type).toBe('technical')
    expect(item.agentWorking).toBe(true)
    expect(item.description).toBe('')
    expect(item.meta).toBe(source.meta)
  })

  test('defaults repos to [] and type to "" when meta/repos are absent', () => {
    const source: SourceItem = { id: 's2', title: 'T', status: 'Todo' }
    const item = defaultToIssueItem(source)
    expect(item.repos).toEqual([])
    expect(item.type).toBe('')
    expect(item.agentWorking).toBe(false)
  })
})

describe('CreateItemInput shape', () => {
  test('accepts draft alongside the existing optional fields', () => {
    const draftTrue: CreateItemInput = { title: 'T', draft: true }
    const draftFalse: CreateItemInput = { title: 'T', repos: ['repo-a'], draft: false }
    const draftOmitted: CreateItemInput = { title: 'T' }
    expect(draftTrue.draft).toBe(true)
    expect(draftFalse.draft).toBe(false)
    expect(draftOmitted.draft).toBeUndefined()
  })
})
