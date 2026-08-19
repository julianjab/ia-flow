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

  test('labelFor rejects a field name containing "=" instead of corrupting the round-trip', () => {
    // labelFor('a=b', 'c') would otherwise produce 'field:a=b=c', which
    // parse() reads back as {name: 'a', value: 'b=c'} — a different name
    // than what was written, silently colliding with a real field 'a'.
    expect(() => codec.labelFor('a=b', 'c')).toThrow(/cannot contain/)
  })

  test('labelFor truncates a value that would exceed the 50-char label cap', () => {
    const label = codec.labelFor('Notes', 'x'.repeat(80))
    expect(label.length).toBeLessThanOrEqual(50)
    expect(label.startsWith('field:Notes=')).toBe(true)
  })

  test('labelFor strips newlines from the value (a label is single-line)', () => {
    expect(codec.labelFor('Notes', 'line1\nline2')).toBe('field:Notes=line1 line2')
  })

  test('labelFor rejects a field name that alone exceeds the label cap', () => {
    expect(() => codec.labelFor('x'.repeat(60), 'v')).toThrow(/exceeds/)
  })

  test('wouldTruncate predicts exactly when labelFor shortens the value', () => {
    expect(codec.wouldTruncate('Notes', 'short')).toBe(false)
    expect(codec.wouldTruncate('Notes', 'x'.repeat(80))).toBe(true)
  })
})
