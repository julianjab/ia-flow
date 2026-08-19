import { describe, expect, test } from 'bun:test'
import { FieldLabelCodec } from '../field-label.js'

describe('FieldLabelCodec', () => {
  const codec = new FieldLabelCodec()

  test('labelFor encodes name=value with the prefix', () => {
    expect(codec.labelFor('Priority', 'high')).toBe('field:Priority=high')
  })

  test('parse decodes a well-formed field label', () => {
    expect(codec.parse('field:Priority=high')).toEqual({ name: 'Priority', value: 'high' })
  })

  test('parse returns null for a label with the wrong prefix', () => {
    expect(codec.parse('status:refine')).toBeNull()
  })

  test('parse returns null when there is no "=" separator', () => {
    expect(codec.parse('field:Priority')).toBeNull()
  })

  test('parse keeps everything after the first "=" as the value', () => {
    expect(codec.parse('field:formula=a=b=c')).toEqual({ name: 'formula', value: 'a=b=c' })
  })

  test('fieldsFromLabels collects every field:* label into a name→value map', () => {
    expect(
      codec.fieldsFromLabels(['bug', 'field:Priority=high', 'status:refine', 'field:Size=M']),
    ).toEqual({ Priority: 'high', Size: 'M' })
  })

  test('withField replaces an existing field label for the same name, case-insensitively', () => {
    expect(codec.withField(['ia-flow', 'field:priority=low', 'bug'], 'Priority', 'high')).toEqual([
      'ia-flow',
      'bug',
      'field:Priority=high',
    ])
  })

  test('withField appends when no prior label for that field exists', () => {
    expect(codec.withField(['ia-flow'], 'Priority', 'high')).toEqual([
      'ia-flow',
      'field:Priority=high',
    ])
  })

  test('withField leaves other fields untouched', () => {
    expect(codec.withField(['field:Size=M', 'field:Priority=low'], 'Priority', 'high')).toEqual([
      'field:Size=M',
      'field:Priority=high',
    ])
  })
})
