import { describe, expect, it } from 'bun:test'
import { parseSlackPermalink } from './permalink.js'

describe('parseSlackPermalink', () => {
  it('parses a top-level message permalink', () => {
    const r = parseSlackPermalink('https://lahaus.slack.com/archives/C0ABC123/p1699999999123456')
    expect(r).toEqual({ channel: 'C0ABC123', ts: '1699999999.123456', thread_ts: undefined })
  })

  it('parses a threaded message permalink with thread_ts', () => {
    const r = parseSlackPermalink(
      'https://lahaus.slack.com/archives/C0ABC123/p1699999999123456?thread_ts=1699999998.000100&cid=C0ABC123',
    )
    expect(r).toEqual({
      channel: 'C0ABC123',
      ts: '1699999999.123456',
      thread_ts: '1699999998.000100',
    })
  })

  it('rejects non-slack URLs', () => {
    expect(() => parseSlackPermalink('https://example.com/foo')).toThrow(/slack\.com/)
  })

  it('rejects malformed slack URLs', () => {
    expect(() => parseSlackPermalink('https://lahaus.slack.com/messages/general')).toThrow(
      /permalink/,
    )
  })
})
