import { describe, expect, it } from 'bun:test'
import { eventMessage } from '../../.config/actions/_lib/intake/message.js'

describe('eventMessage', () => {
  it('reads a human comment with its author', () => {
    expect(eventMessage('issue_comment', { author: 'julian', body: ' usá el enum \n' })).toBe(
      'Comentario de @julian:\nusá el enum',
    )
  })

  it('says where it happened when the event is about a PR', () => {
    expect(eventMessage('issue_comment', { author: 'rev', body: 'ok', pr: { number: 12 } })).toBe(
      'Comentario de @rev en el PR #12:\nok',
    )
  })

  it('reads a review by its verdict', () => {
    expect(
      eventMessage('pull_request_review', {
        reviewer: 'rev',
        state: 'CHANGES_REQUESTED',
        body: 'falta un test',
        pr: { number: 12 },
      }),
    ).toBe('@rev pidió cambios en el PR #12:\nfalta un test')
    expect(eventMessage('pull_request_review', { reviewer: 'rev', state: 'approved' })).toBe(
      '@rev aprobó.',
    )
  })

  it('reads a CI result, and falls back to the event type', () => {
    expect(eventMessage('workflow_run', { conclusion: 'failure', pr: { number: 3 } })).toBe(
      'El CI en el PR #3 terminó en failure.',
    )
    expect(eventMessage('otro', {})).toBe('Evento otro.')
  })
})
