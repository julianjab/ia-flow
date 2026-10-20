import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { repairNestedObjects } from '../nestedInput.js'

const Submit = z.strictObject({
  result: z.strictObject({ text: z.string() }),
  report: z.strictObject({ summary: z.string() }).optional(),
  note: z.string().optional(),
})

describe('repairNestedObjects', () => {
  it('parses an object that arrived serialized as a JSON string', () => {
    expect(
      repairNestedObjects(Submit, { result: '{"text": "## lines 50-62\\ndef _lead():"}' }),
    ).toEqual({
      result: { text: '## lines 50-62\ndef _lead():' },
    })
  })

  it('recovers the leaked tool-use <parameter> as the field it names', () => {
    const raw = { result: '\n<parameter name="text">## lines 89-134\n    def setUp(self):\n' }

    expect(repairNestedObjects(Submit, raw)).toEqual({
      result: { text: '## lines 89-134\n    def setUp(self):' },
    })
  })

  it('drops the closing </parameter> when the model wrote it', () => {
    expect(
      repairNestedObjects(Submit, { result: '<parameter name="text">a</parameter>\n' }),
    ).toEqual({
      result: { text: 'a' },
    })
  })

  it('repairs an optional object field too, and keeps the other fields', () => {
    expect(
      repairNestedObjects(Submit, { result: { text: 'a' }, report: '{"summary": "ok"}' }),
    ).toEqual({
      result: { text: 'a' },
      report: { summary: 'ok' },
    })
  })

  it('leaves a <parameter> that names a key the object does not declare', () => {
    expect(repairNestedObjects(Submit, { result: '<parameter name="body">a' })).toBeUndefined()
  })

  it('does not touch fields declared as strings, or plain text in an object field', () => {
    expect(repairNestedObjects(Submit, { result: { text: 'a' }, note: '{"x": 1}' })).toBeUndefined()
    expect(repairNestedObjects(Submit, { result: '## lines 1-2' })).toBeUndefined()
  })

  it('does not take a JSON array or scalar as the object', () => {
    expect(repairNestedObjects(Submit, { result: '["a"]' })).toBeUndefined()
    expect(repairNestedObjects(Submit, { result: '"a"' })).toBeUndefined()
  })

  it('ignores input that is not an object', () => {
    expect(repairNestedObjects(Submit, 'text')).toBeUndefined()
    expect(repairNestedObjects(Submit, null)).toBeUndefined()
  })
})
