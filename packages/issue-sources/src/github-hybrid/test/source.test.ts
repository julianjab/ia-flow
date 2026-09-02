import { describe, expect, it } from 'bun:test'
import type { SourceItem } from '../../contract.js'
import { dedupeByName, isTrackedByIssuesConfig, mergeByIssueId } from '../source.js'

function issueItem(over: Partial<SourceItem> & { issueId: string }): SourceItem {
  const { issueId, ...rest } = over
  return {
    id: issueId,
    title: 'Un issue',
    status: 'status:backlog',
    repos: 'ia-flow',
    meta: { issueId, labels: ['status:backlog'] },
    ...rest,
  }
}

function projectItem(
  over: Partial<SourceItem> & {
    issueId: string
    status?: string
    owner?: string
    repoName?: string
  },
): SourceItem {
  const { issueId, status, owner, repoName, ...rest } = over
  return {
    id: `PVTI_${issueId}`,
    title: 'Un issue en el board',
    status: status ?? 'In Progress',
    repos: 'ia-flow',
    meta: {
      issueId,
      ghProjectId: 'PVT_1',
      fields: {},
      owner: owner ?? 'la-haus',
      repoName: repoName ?? 'ia-flow',
    },
    ...rest,
  }
}

const ISSUES_CONFIG = { owner: 'la-haus', repo: 'ia-flow' }

describe('mergeByIssueId', () => {
  it('un issue sin contraparte en el board queda tal cual', () => {
    const issue = issueItem({ issueId: 'I_1' })
    expect(mergeByIssueId([issue], [])).toEqual([issue])
  })

  it('un issue CON contraparte en el board se reemplaza por el resto del item del board, pero conserva la identidad del issue', () => {
    const issue = issueItem({ issueId: 'I_1', status: 'status:backlog' })
    const project = projectItem({ issueId: 'I_1', status: 'In Progress' })
    const merged = mergeByIssueId([issue], [project])
    // id sigue siendo el del issue (I_1), no el del ProjectV2Item (PVTI_I_1)
    // — es lo que evita que agregar/sacar el issue del board le cambie la
    // identidad a una task ya despachada.
    expect(merged).toEqual([
      { ...project, id: 'I_1', meta: { ...project.meta, projectItemId: 'PVTI_I_1' } },
    ])
  })

  it('si el board tiene el item pero sin Status seteado, se conserva el status de la label', () => {
    const issue = issueItem({ issueId: 'I_1', status: 'status:backlog' })
    const project = projectItem({ issueId: 'I_1', status: '' })
    const merged = mergeByIssueId([issue], [project])
    expect(merged[0]?.status).toBe('status:backlog')
  })

  it('un item del board sin issue tracked (fuera del anchor label) no aparece — el set lo define issues', () => {
    const issue = issueItem({ issueId: 'I_1' })
    const otherProjectItem = projectItem({ issueId: 'I_99' })
    const merged = mergeByIssueId([issue], [otherProjectItem])
    expect(merged).toEqual([issue])
  })

  it('varios issues, sólo algunos en el board', () => {
    const trackedOnly = issueItem({ issueId: 'I_1' })
    const trackedAndBoarded = issueItem({ issueId: 'I_2', status: 'status:doing' })
    const boardCounterpart = projectItem({ issueId: 'I_2', status: 'In Progress' })
    const merged = mergeByIssueId([trackedOnly, trackedAndBoarded], [boardCounterpart])
    expect(merged[0]).toEqual(trackedOnly)
    expect(merged[1]?.id).toBe('I_2')
    expect(merged[1]?.meta?.projectItemId).toBe(boardCounterpart.id)
  })
})

describe('dedupeByName', () => {
  it('el que aparece primero gana, case-insensitive', () => {
    const a = { name: 'Status', extra: 'del board' }
    const b = { name: 'status', extra: 'de labels' }
    expect(dedupeByName([a, b])).toEqual([a])
  })

  it('sin colisiones devuelve todo', () => {
    const a = { name: 'Status' }
    const b = { name: 'Priority' }
    expect(dedupeByName([a, b])).toEqual([a, b])
  })
})

describe('isTrackedByIssuesConfig', () => {
  it('owner y repo coinciden, sin anchor label → tracked', () => {
    const item = projectItem({ issueId: 'I_1' })
    expect(isTrackedByIssuesConfig(item, ISSUES_CONFIG)).toBe(true)
  })

  it('mismo nombre de repo, owner distinto → NO tracked (repos homónimos de orgs distintas)', () => {
    const item = projectItem({ issueId: 'I_1', owner: 'otra-org', repoName: 'ia-flow' })
    expect(isTrackedByIssuesConfig(item, ISSUES_CONFIG)).toBe(false)
  })

  it('mismo owner, repo distinto → no tracked', () => {
    const item = projectItem({ issueId: 'I_1', repoName: 'otro-repo' })
    expect(isTrackedByIssuesConfig(item, ISSUES_CONFIG)).toBe(false)
  })

  it('con anchor label configurada, el item tiene que traerla', () => {
    const withLabel = projectItem({ issueId: 'I_1' })
    withLabel.meta = { ...withLabel.meta, labels: ['ia-flow-tracked'] }
    const withoutLabel = projectItem({ issueId: 'I_2' })
    const config = { ...ISSUES_CONFIG, anchorLabel: 'ia-flow-tracked' }
    expect(isTrackedByIssuesConfig(withLabel, config)).toBe(true)
    expect(isTrackedByIssuesConfig(withoutLabel, config)).toBe(false)
  })

  it('sin owner/repoName en meta → no tracked, no revienta', () => {
    const item: SourceItem = { id: 'I_1', title: 'x', status: '', repos: 'ia-flow', meta: {} }
    expect(isTrackedByIssuesConfig(item, ISSUES_CONFIG)).toBe(false)
  })
})
