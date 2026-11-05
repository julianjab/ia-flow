import { describe, expect, it } from 'bun:test'
import type { EventLogEntry } from '@ia-flow/shared'
import { resumeStage } from './resumeStage.js'

const statuses = { refine: 'Refine', build: 'Build', review: 'Tests' }

function event(
  id: string,
  summary: EventLogEntry['summary'],
  executionId?: string,
  type = 'issue.status_changed',
): EventLogEntry {
  return {
    id,
    type,
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

  // ai-mobile-app#818: la épica en Build, su custodio escaló por un hijo trabado, y "Responder y
  // destrabar" la movió a Review (lo que disparó epic-validation con hijos abiertos). Los avisos
  // de los hijos quedan bajo la épica con el `to` del HIJO.
  describe('an epic (events of its children are logged against it)', () => {
    const child = (id: string, to: string, executionId?: string) =>
      event(id, { from: 'Build', to }, executionId, 'issue.child_status_changed')
    const epic = [
      event('6', { label: 'blocked' }, 'run-steward', 'issue.child_labeled'),
      // `Tests` es la Review de estos `statuses`.
      child('5', 'Tests', 'run-child-built'),
      child('4', 'Tests'),
      event('3', { from: 'Refine', to: 'Build' }, 'run-start'),
      event('2', { from: 'Refined', to: 'Refine' }, 'run-refine'),
    ]

    it('ignores the column of a child when the run was started by a child event', () => {
      expect(
        resumeStage(epic, { id: 'run-steward', pipeline_id: 'epic-child-stuck' }, statuses),
      ).toBe('Build')
    })

    it('ignores the column of a child even if a child event started the run', () => {
      expect(
        resumeStage(epic, { id: 'run-child-built', pipeline_id: 'epic-child-built' }, statuses),
      ).toBe('Build')
    })

    it('ignores the column a blocker reached (issue.blockers_refined)', () => {
      const events = [
        event('2', { to: 'Build' }, 'run-x', 'issue.blockers_refined'),
        event('1', { to: 'Refine' }),
      ]
      expect(resumeStage(events, { id: 'run-x', pipeline_id: 'x' }, statuses)).toBe('Refine')
    })

    it('keeps the column the epic is in when its own move fell out of the event window', () => {
      const onlyChildren = epic.slice(0, 3)
      expect(
        resumeStage(
          onlyChildren,
          { id: 'run-steward', pipeline_id: 'epic-child-stuck' },
          statuses,
          'Build',
        ),
      ).toBe('Build')
      // Sin saber la columna actual, no la adivina: la bandeja contesta 409.
      expect(
        resumeStage(onlyChildren, { id: 'run-steward', pipeline_id: 'epic-child-stuck' }, statuses),
      ).toBeUndefined()
    })
  })

  it('only looks at moves before the run that failed', () => {
    // Newest first: the card was moved to Review after the comment-started run failed.
    const events = [
      event('4', { to: 'Tests' }),
      event('3', { action: 'created' }, 'run-c'),
      event('2', { to: 'Build' }, 'run-b'),
    ]
    expect(resumeStage(events, { id: 'run-c', pipeline_id: 'x' }, statuses)).toBe('Build')
  })

  it('does not take a current column that is not a stage', () => {
    expect(
      resumeStage([], { id: 'run-a', pipeline_id: 'comment' }, statuses, 'Blocked'),
    ).toBeUndefined()
  })

  it('knows nothing without events', () => {
    expect(resumeStage([], undefined, statuses)).toBeUndefined()
  })
})
