import { describe, expect, test } from 'bun:test'
import { StatusLabelCodec, WORKING_LABEL, isTracked, withWorking } from '../status-label.js'

describe('StatusLabelCodec', () => {
  const codec = new StatusLabelCodec()

  test('statusFromLabels extracts the status:* suffix', () => {
    expect(codec.statusFromLabels(['bug', 'status:refine'])).toBe('refine')
  })

  test('statusFromLabels returns empty string when no status label is present', () => {
    expect(codec.statusFromLabels(['bug', 'ia-flow'])).toBe('')
  })

  test('labelFor prefixes the status name', () => {
    expect(codec.labelFor('refine')).toBe('status:refine')
  })

  test('withStatus replaces an existing status label, keeping the rest', () => {
    expect(codec.withStatus(['ia-flow', 'status:refine', 'bug'], 'done')).toEqual([
      'ia-flow',
      'bug',
      'status:done',
    ])
  })

  test('withStatus appends when no prior status label exists', () => {
    expect(codec.withStatus(['ia-flow'], 'refine')).toEqual(['ia-flow', 'status:refine'])
  })

  test('respects a custom prefix', () => {
    const custom = new StatusLabelCodec('pipeline/')
    expect(custom.statusFromLabels(['pipeline/review'])).toBe('review')
    expect(custom.labelFor('review')).toBe('pipeline/review')
  })
})

describe('isTracked', () => {
  test('true when the anchor label is present', () => {
    expect(isTracked(['ia-flow', 'bug'], 'ia-flow')).toBe(true)
  })

  test('false when the anchor label is absent', () => {
    expect(isTracked(['bug'], 'ia-flow')).toBe(false)
  })
})

describe('withWorking', () => {
  test('adds the working label', () => {
    expect(withWorking(['ia-flow'], true)).toEqual(['ia-flow', WORKING_LABEL])
  })

  test('removes the working label', () => {
    expect(withWorking(['ia-flow', WORKING_LABEL], false)).toEqual(['ia-flow'])
  })

  test('adding twice does not duplicate', () => {
    expect(withWorking(['ia-flow', WORKING_LABEL], true)).toEqual(['ia-flow', WORKING_LABEL])
  })
})
