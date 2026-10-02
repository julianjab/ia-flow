import { describe, expect, it } from 'bun:test'
import {
  fieldLabel,
  type LabelScheme,
  labelsOfField,
  statusLabel,
  statusOfLabel,
  statusOfLabels,
  valueOfField,
} from './labelScheme.js'

const scheme: LabelScheme = {
  prefix: 'status:',
  statuses: ['Todo', 'Refine', 'Build', 'Tests', 'Done'],
}
const open: LabelScheme = { prefix: 'status:', statuses: [] }

describe('Status ⇄ label', () => {
  it('a column is a slugged label with the prefix', () => {
    expect(statusLabel('Build', scheme)).toBe('status:build')
    expect(statusLabel('build', scheme)).toBe('status:build')
    expect(statusLabel('Waiting for CI', open)).toBe('status:waiting-for-ci')
  })

  it('reads the column back with the declared spelling', () => {
    expect(statusOfLabel('status:build', scheme)).toBe('Build')
    expect(statusOfLabel('Status:Build', scheme)).toBe('Build')
  })

  it('a label outside the declared columns is not a Status', () => {
    expect(statusOfLabel('status:archived', scheme)).toBeUndefined()
    expect(statusOfLabel('build', scheme)).toBeUndefined()
    expect(statusOfLabel('status:', scheme)).toBeUndefined()
  })

  it('without declared columns, any prefixed label is one', () => {
    expect(statusOfLabel('status:review', open)).toBe('Review')
  })

  it('with several (a move in progress), the most advanced column wins', () => {
    expect(statusOfLabels(['bug', 'status:build', 'status:refine'], scheme)).toBe('Build')
    expect(statusOfLabels(['status:refine', 'status:tests'], scheme)).toBe('Tests')
    expect(statusOfLabels(['bug'], scheme)).toBeUndefined()
  })

  it('without declared columns, the last one wins', () => {
    expect(statusOfLabels(['status:a', 'status:b'], open)).toBe('B')
  })
})

describe('other fields', () => {
  it('live under <field>:<value>', () => {
    expect(fieldLabel('Task Type', 'Functional', scheme)).toBe('task-type:functional')
    expect(fieldLabel('Working', 'Yes', scheme)).toBe('working:yes')
    expect(fieldLabel('Status', 'Done', scheme)).toBe('status:done')
  })

  it('read their value back, or nothing when unset', () => {
    const labels = ['bug', 'task-type:functional', 'status:build']
    expect(valueOfField(labels, 'Task Type', scheme)).toBe('functional')
    expect(valueOfField(labels, 'Working', scheme)).toBeUndefined()
    expect(valueOfField(labels, 'Status', scheme)).toBe('build')
  })

  it('occupy every label with their prefix', () => {
    expect(labelsOfField(['working:yes', 'working:paused', 'bug'], 'Working', scheme)).toEqual([
      'working:yes',
      'working:paused',
    ])
  })
})
