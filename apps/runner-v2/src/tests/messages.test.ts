import { describe, expect, it } from 'bun:test'
import { createEvent } from '@ia-tools/agent-engine'
import { formatEventMessage } from '../messages.js'

describe('formatEventMessage', () => {
  it('reads a human comment with its author', () => {
    const event = createEvent('issue_comment', { author: 'julian', body: ' usá el enum \n' })
    expect(formatEventMessage(event)).toBe('Comentario de @julian:\nusá el enum')
  })

  it('says where it happened when the event is about a PR', () => {
    const event = createEvent('issue_comment', { author: 'rev', body: 'ok', pr: { number: 12 } })
    expect(formatEventMessage(event)).toBe('Comentario de @rev en el PR #12:\nok')
  })

  it('reads a review by its verdict', () => {
    const changes = createEvent('pull_request_review', {
      reviewer: 'rev',
      state: 'CHANGES_REQUESTED',
      body: 'falta un test',
      pr: { number: 12 },
    })
    expect(formatEventMessage(changes)).toBe('@rev pidió cambios en el PR #12:\nfalta un test')
    const approved = createEvent('pull_request_review', { reviewer: 'rev', state: 'approved' })
    expect(formatEventMessage(approved)).toBe('@rev aprobó.')
  })

  it('reads a CI result, and falls back to the event type', () => {
    expect(
      formatEventMessage(createEvent('workflow_run', { conclusion: 'failure', pr: { number: 3 } })),
    ).toBe('El CI en el PR #3 terminó en failure.')
    expect(formatEventMessage(createEvent('otro', {}))).toBe('Evento otro.')
  })
})
