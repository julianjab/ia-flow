import { describe, expect, it } from 'bun:test'
import { deliveryScope } from '../serve.js'

const repository = { full_name: 'la-haus/subscriptions' }

describe('deliveryScope', () => {
  it('tags a delivery with its id, repo and issue or PR, for the trace', () => {
    expect(
      deliveryScope({
        event: 'issue_comment',
        id: 'd-1',
        payload: { issue: { number: 7 }, repository },
      }),
    ).toEqual({
      source: 'webhook',
      deliveryId: 'd-1',
      repo: 'la-haus/subscriptions',
      issue: 'la-haus/subscriptions#7',
    })
    expect(
      deliveryScope({
        event: 'pull_request',
        payload: { pull_request: { number: 12 }, repository },
      }),
    ).toMatchObject({ issue: 'la-haus/subscriptions#12' })
  })

  it('leaves out what the payload does not bring', () => {
    expect(deliveryScope({ event: 'projects_v2_item', payload: {} })).toEqual({
      source: 'webhook',
    })
  })
})
