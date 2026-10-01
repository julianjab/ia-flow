import { describe, expect, it } from 'vitest'
import { parseGithubProjectItemPayload } from '../GithubProjectItemPayload.js'

function itemPayload(fieldValue?: Record<string, unknown>) {
  return {
    action: 'edited',
    projects_v2_item: {
      node_id: 'PVTI_item',
      project_node_id: 'PVT_project',
      content_node_id: 'I_issue',
      content_type: 'Issue',
    },
    ...(fieldValue ? { changes: { field_value: fieldValue } } : {}),
    sender: { login: 'julian' },
  }
}

describe('parseGithubProjectItemPayload', () => {
  it('extracts the node ids and the old/new value of a single-select change', () => {
    const payload = parseGithubProjectItemPayload(
      itemPayload({
        field_name: 'Status',
        field_type: 'single_select',
        from: { id: 'a', name: 'Refined' },
        to: { id: 'b', name: 'Build' },
      }),
    )
    expect(payload).toEqual({
      itemId: 'PVTI_item',
      projectNodeId: 'PVT_project',
      contentNodeId: 'I_issue',
      contentType: 'Issue',
      fieldName: 'Status',
      fieldType: 'single_select',
      from: 'Refined',
      to: 'Build',
      sender: 'julian',
    })
  })

  it('leaves from/to absent when GitHub does not send them (e.g. a labels field)', () => {
    const payload = parseGithubProjectItemPayload(
      itemPayload({ field_name: 'Labels', field_type: 'labels' }),
    )
    expect(payload).not.toHaveProperty('from')
    expect(payload).not.toHaveProperty('to')
    expect(payload.fieldName).toBe('Labels')
  })

  it('handles actions that do not edit a field (created, archived, …)', () => {
    const payload = parseGithubProjectItemPayload(itemPayload())
    expect(payload.fieldName).toBe('')
    expect(payload.itemId).toBe('PVTI_item')
  })
})
