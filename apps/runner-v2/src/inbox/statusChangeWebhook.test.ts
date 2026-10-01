/**
 * «Re-ejecutar review»: el webhook armado a mano pasa por el intake como si la persona hubiera
 * movido la card a Review.
 */
import { describe, expect, it } from 'bun:test'
import { locate } from '@ia-flow/github-webhook'
import { statusChangeWebhook } from './statusChangeWebhook.js'

describe('statusChangeWebhook', () => {
  it('the intake reads it as the card arriving at the column, moved by that person', () => {
    const delivery = statusChangeWebhook({ itemId: 'PVTI_1', status: 'Review', sender: 'julian' })
    expect(delivery.event).toBe('projects_v2_item')
    expect(locate(delivery.event, delivery.payload)).toEqual({
      item: 'PVTI_1',
      emit: 'issue.status_changed',
      status: 'Review',
      extra: { from: undefined, to: 'Review', sender: 'julian' },
    })
  })
})
