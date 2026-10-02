import { describe, expect, it } from 'bun:test'
import type { EventLogEntry } from '@ia-flow/shared'
import { resumeStage } from './resumeStage.js'

const statuses = { refine: 'Refine', build: 'Build', review: 'Tests' }

function event(id: string, summary: EventLogEntry['summary'], executionId?: string): EventLogEntry {
  return {
    id,
    type: 'issue.status_changed',
    occurred_at: '2026-10-02T11:00:00Z',
    depth: 0,
    summary,
    outcome: 'dispatched',
    decisions: [],
    ...(executionId ? { execution_id: executionId } : {}),
  }
}

describe('resumeStage', () => {
  it('goes back to the column that started the execution that failed', () => {
    // Newest first: the engine moved the card to Blocked after the failure.
    const events = [
      event('3', { to: 'Blocked' }),
      event('2', { to: 'Build' }, 'run-b'),
      event('1', { to: 'Refine' }, 'run-a'),
    ]
    expect(resumeStage(events, { id: 'run-a', pipeline_id: 'x' }, statuses)).toBe('Refine')
    expect(resumeStage(events, { id: 'run-b', pipeline_id: 'x' }, statuses)).toBe('Build')
  })

  it('falls back to the latest stage move when a comment started the run', () => {
    const events = [
      event('4', { action: 'created' }, 'run-c'),
      event('3', { to: 'Blocked' }),
      event('2', { to: 'Refine' }, 'run-a'),
    ]
    expect(resumeStage(events, { id: 'run-c', pipeline_id: 'x' }, statuses)).toBe('Refine')
  })

  it('never returns Blocked or a column the inbox does not know', () => {
    const events = [event('2', { to: 'Blocked' }), event('1', { to: 'Backlog' })]
    expect(resumeStage(events, { id: 'run-a', pipeline_id: 'x' }, statuses)).toBeUndefined()
  })

  it('falls back to the pipeline of the failed run when no event says the column', () => {
    // An issues board can start a run with a bare label: the event carries no `to`.
    const labeled = [event('1', { action: 'labeled' }, 'run-a')]
    expect(resumeStage(labeled, { id: 'run-a', pipeline_id: 'refine' }, statuses)).toBe('Refine')
    expect(resumeStage(labeled, { id: 'run-a', pipeline_id: 'Build' }, statuses)).toBe('Build')
    expect(resumeStage(labeled, { id: 'run-a', pipeline_id: 'review' }, statuses)).toBe('Tests')
    // A pipeline that is not a stage (a comment, the CI) says nothing.
    expect(resumeStage(labeled, { id: 'run-a', pipeline_id: 'comment' }, statuses)).toBeUndefined()
  })

  it('knows nothing without events', () => {
    expect(resumeStage([], undefined, statuses)).toBeUndefined()
  })
})
