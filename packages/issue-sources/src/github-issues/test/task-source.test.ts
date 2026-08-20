import { describe, expect, test } from 'bun:test'
import type { IssueItem } from '../../contract.js'
import type { GitHubIssuesApi } from '../api/issues-client.js'
import { FieldLabelCodec } from '../field-label.js'
import type { GitHubIssueSourceConfig } from '../source.js'
import { StatusLabelCodec } from '../status-label.js'
import { GitHubIssueTaskSource } from '../task-source.js'

// Same DI pattern as source.test.ts — a fake GitHubIssuesApi instead of
// mocking `fetch`.
function fakeApi(overrides: Partial<GitHubIssuesApi> = {}): GitHubIssuesApi {
  return {
    listByLabel: async () => [],
    getByNumber: async () => null,
    getById: async () => null,
    listRepoLabels: async () => [],
    replaceLabels: async () => {},
    create: async () => {
      throw new Error('not stubbed')
    },
    addComment: async () => {},
    listComments: async () => [],
    updateBody: async () => {},
    getBlockers: async () => [],
    addBlockedBy: async () => {},
    getLinkedBranch: async () => null,
    ...overrides,
  } as GitHubIssuesApi
}

const CONFIG: GitHubIssueSourceConfig = {
  owner: 'la-haus',
  repo: 'ia-flow',
  anchorLabel: 'ia-flow-refine',
}

const ITEM: IssueItem = {
  id: 'ISSUE_1',
  title: 'Do the thing',
  description: 'Body text',
  status: 'refine',
  type: '',
  repos: ['ia-flow'],
  issueNumber: 42,
  labels: ['ia-flow-refine', 'status:refine'],
  meta: { issueId: 'I_node1', issueNumber: 42 },
}

function makeManager(item: IssueItem = ITEM): GitHubIssueTaskSource {
  return new GitHubIssueTaskSource(
    CONFIG,
    fakeApi(),
    new StatusLabelCodec(),
    new FieldLabelCodec(),
    item,
    () => {},
  )
}

describe('GitHubIssueTaskSource.getSourceToolContext', () => {
  test('returns owner/repoName/issue identity with no projectId — no Projects v2 board here', () => {
    const manager = makeManager()
    const ctx = manager.getSourceToolContext()

    expect(ctx.owner).toBe('la-haus')
    expect(ctx.repoName).toBe('ia-flow')
    expect(ctx.issueId).toBe('I_node1')
    expect(ctx.issueNumber).toBe(42)
    expect(ctx.projectId).toBeUndefined()
    expect(ctx.fields).toEqual({})
  })
})
