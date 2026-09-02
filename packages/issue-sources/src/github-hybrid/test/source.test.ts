import { describe, expect, it } from 'bun:test'
import type { SourceItem } from '../../contract.js'
import { dedupeByName, mergeByIssueId } from '../source.js'

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

function projectItem(over: Partial<SourceItem> & { issueId: string; status?: string }): SourceItem {
  const { issueId, status, ...rest } = over
  return {
    id: `PVTI_${issueId}`,
    title: 'Un issue en el board',
    status: status ?? 'In Progress',
    repos: 'ia-flow',
    meta: { issueId, ghProjectId: 'PVT_1', fields: {} },
    ...rest,
  }
}

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
