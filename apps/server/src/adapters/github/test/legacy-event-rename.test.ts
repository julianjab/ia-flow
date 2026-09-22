import { describe, expect, it } from 'bun:test'
import { planLegacyRename, usesLegacyTaxonomy } from '../legacy-event-rename.js'

describe('usesLegacyTaxonomy', () => {
  it('detecta un tipo curado entre otros', () => {
    expect(usesLegacyTaxonomy(['issue.status_changed', 'pr.opened'])).toBe(true)
  })

  it('nombres crudos, o el scan de la fuente, no son taxonomía vieja', () => {
    expect(usesLegacyTaxonomy(['issue.status_changed', 'pull_request', 'issue_comment'])).toBe(
      false,
    )
  })
})

describe('planLegacyRename', () => {
  it('sin taxonomía vieja, no hay nada que hacer', () => {
    expect(planLegacyRename(['issue.status_changed'], null)).toBeNull()
  })

  it('un tipo simple se traduce y agrega el requirement de action', () => {
    expect(planLegacyRename(['pr.synchronize'], null)).toEqual({
      onTypes: ['pull_request'],
      when: [{ field: 'action', op: '=', value: 'synchronize' }],
    })
  })

  it('pr.merged sola: pull_request + [action=closed, pr.merged=true]', () => {
    expect(planLegacyRename(['pr.merged'], null)).toEqual({
      onTypes: ['pull_request'],
      when: [
        { field: 'action', op: '=', value: 'closed' },
        { field: 'pr.merged', op: '=', value: 'true' },
      ],
    })
  })

  it('un when previo se cruza-producto, no se concatena', () => {
    expect(
      planLegacyRename(['pr.opened'], [{ field: 'pr.isDraft', op: '=', value: 'false' }]),
    ).toEqual({
      onTypes: ['pull_request'],
      when: [
        { field: 'pr.isDraft', op: '=', value: 'false' },
        { field: 'action', op: '=', value: 'opened' },
        { field: 'pr.isDraft', op: '=', value: 'false', logic: 'or' },
        { field: 'action', op: '=', value: 'reopened' },
      ],
    })
  })

  it('mezclar un tipo curado con uno no curado se saltea', () => {
    const plan = planLegacyRename(['issue.status_changed', 'pr.review_submitted'], null)
    expect(plan && 'skip' in plan && plan.skip).toBe(true)
  })

  it('dos tipos curados con requisitos de action distintos se saltean', () => {
    const plan = planLegacyRename(['issues.opened', 'pr.synchronize'], null)
    expect(plan && 'skip' in plan && plan.skip).toBe(true)
  })

  it('when en formato Record se saltea', () => {
    const plan = planLegacyRename(['pr.opened'], { status: 'Ready' })
    expect(plan).toEqual({
      skip: true,
      reason: 'when en formato Record — necesita migración MANUAL',
    })
  })

  it('ci.finished sola migra pese a mapear a dos tipos crudos — es el mismo hecho', () => {
    expect(planLegacyRename(['ci.finished'], null)).toEqual({
      onTypes: ['check_suite', 'workflow_run'],
      when: [{ field: 'action', op: '=', value: 'completed' }],
    })
  })
})
