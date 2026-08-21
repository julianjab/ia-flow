import { afterEach, describe, expect, it } from 'bun:test'
import type { ITaskSource } from '@ia-flow/issue-sources'
import type { Task } from '@ia-flow/shared'
import { resolveLinkedBranch } from '../linked-branch.js'

const originalFetch = globalThis.fetch
const originalToken = Bun.env.GITHUB_TOKEN

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalToken === undefined) delete Bun.env.GITHUB_TOKEN
  else Bun.env.GITHUB_TOKEN = originalToken
})

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    title: 'Add login',
    description: '',
    type: 'functional',
    repos: ['backend'],
    status: 'Build',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

const namer = async () => 'proposed-branch'

describe('resolveLinkedBranch', () => {
  it('agente sin write tools y sin requiresBranch → no toca la task', async () => {
    const manager = { getLinkedBranchRef: () => ({ issueNodeId: 'i1', owner: 'o', repoName: 'r' }) }
    const result = await resolveLinkedBranch({
      task: task(),
      agentDef: { tools: ['fs_read'] },
      resolvedProviderId: 'anthropic-api',
      manager: manager as unknown as ITaskSource,
      linkedBranchNamer: namer,
    })
    expect(result.branch).toBeUndefined()
  })

  it('la task ya tiene branch → no vuelve a resolverla', async () => {
    const manager = { getLinkedBranchRef: () => ({ issueNodeId: 'i1', owner: 'o', repoName: 'r' }) }
    const result = await resolveLinkedBranch({
      task: task({ branch: 'ya-existe' }),
      agentDef: { requiresBranch: true },
      resolvedProviderId: 'anthropic-api',
      manager: manager as unknown as ITaskSource,
      linkedBranchNamer: namer,
    })
    expect(result.branch).toBe('ya-existe')
  })

  it('el source no expone getLinkedBranchRef → no toca la task', async () => {
    const manager = {}
    const result = await resolveLinkedBranch({
      task: task(),
      agentDef: { requiresBranch: true },
      resolvedProviderId: 'anthropic-api',
      manager: manager as unknown as ITaskSource,
      linkedBranchNamer: namer,
    })
    expect(result.branch).toBeUndefined()
  })

  it('getLinkedBranchRef devuelve null (issue sin ref linkeable) → no toca la task', async () => {
    const manager = { getLinkedBranchRef: () => null }
    const result = await resolveLinkedBranch({
      task: task(),
      agentDef: { requiresBranch: true },
      resolvedProviderId: 'anthropic-api',
      manager: manager as unknown as ITaskSource,
      linkedBranchNamer: namer,
    })
    expect(result.branch).toBeUndefined()
  })

  it('createLinkedBranch falla (sin GITHUB_TOKEN) → cae al fallback, no lanza', async () => {
    delete Bun.env.GITHUB_TOKEN
    const manager = { getLinkedBranchRef: () => ({ issueNodeId: 'i1', owner: 'o', repoName: 'r' }) }
    const result = await resolveLinkedBranch({
      task: task(),
      agentDef: { requiresBranch: true },
      resolvedProviderId: 'anthropic-api',
      manager: manager as unknown as ITaskSource,
      linkedBranchNamer: namer,
    })
    expect(result.branch).toBeUndefined()
  })

  it('crea la branch linkeada y la refleja en task.branch', async () => {
    Bun.env.GITHUB_TOKEN = 'gh-test-token'
    let call = 0
    globalThis.fetch = (async () => {
      call += 1
      // 1er round trip: resolveRepoHead. 2do: la mutation createLinkedBranch.
      const body =
        call === 1
          ? {
              data: {
                repository: {
                  id: 'repo-id',
                  defaultBranchRef: { name: 'main', target: { oid: 'sha123' } },
                },
              },
            }
          : {
              data: {
                createLinkedBranch: { linkedBranch: { ref: { name: 'proposed-branch' } } },
              },
            }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const manager = { getLinkedBranchRef: () => ({ issueNodeId: 'i1', owner: 'o', repoName: 'r' }) }
    const result = await resolveLinkedBranch({
      task: task(),
      agentDef: { requiresBranch: true },
      resolvedProviderId: 'anthropic-api',
      manager: manager as unknown as ITaskSource,
      linkedBranchNamer: namer,
    })

    expect(result.branch).toBe('proposed-branch')
    expect(call).toBe(2)
  })
})
