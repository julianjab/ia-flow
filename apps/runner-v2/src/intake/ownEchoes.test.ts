import { describe, expect, it } from 'bun:test'
import type { Delivery } from './dispatch.js'
import { markerEcho } from './ownEchoes.js'

const OWN = /\[bot\]$/
const FIELDS = new Set(['Working'])

function edited(field: string, sender: string, action = 'edited'): Delivery {
  return {
    event: 'projects_v2_item',
    id: 'd-1',
    payload: {
      action,
      projects_v2_item: { node_id: 'ITEM', content_type: 'Issue' },
      changes: { field_value: { field_name: field, field_type: 'single_select' } },
      sender: { login: sender },
    },
  }
}

describe('markerEcho', () => {
  it('the runner editing its own Working marker is an echo', () => {
    expect(markerEcho(edited('Working', 'ai-lh-developer[bot]'), FIELDS, OWN)).toBe(
      'eco de la marca Working (ai-lh-developer[bot])',
    )
  })

  it('matches the field name case-insensitively', () => {
    expect(markerEcho(edited('working', 'x[bot]'), FIELDS, OWN)).toBeDefined()
  })

  it('a person editing Working is not an echo', () => {
    expect(markerEcho(edited('Working', 'julianjab'), FIELDS, OWN)).toBeUndefined()
  })

  it('the runner editing another field (Status) is not an echo', () => {
    expect(markerEcho(edited('Status', 'ai-lh-developer[bot]'), FIELDS, OWN)).toBeUndefined()
  })

  it('a field that no project uses as marker is not an echo', () => {
    expect(markerEcho(edited('Working', 'x[bot]'), new Set(), OWN)).toBeUndefined()
  })

  it('only `edited` deliveries of projects_v2_item', () => {
    expect(markerEcho(edited('Working', 'x[bot]', 'created'), FIELDS, OWN)).toBeUndefined()
    expect(
      markerEcho({ event: 'issues', payload: { action: 'edited' } }, FIELDS, OWN),
    ).toBeUndefined()
  })
})
