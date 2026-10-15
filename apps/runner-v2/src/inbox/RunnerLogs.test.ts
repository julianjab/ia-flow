import { describe, expect, it } from 'bun:test'
import type { LogRecord } from '@ia-flow/telemetry'
import { RunnerLogs } from './RunnerLogs.js'

const record = (message: string, extra: Partial<LogRecord> = {}): LogRecord => ({
  time: new Date('2026-10-15T12:00:00Z'),
  level: 'info',
  scope: 'runner',
  message,
  attributes: {},
  ...extra,
})

describe('RunnerLogs', () => {
  it('keeps only the last `capacity` lines and keeps counting seq', () => {
    const logs = new RunnerLogs(2)
    for (const message of ['a', 'b', 'c']) logs.sink(record(message))
    const page = logs.page()
    expect(page.lines.map((line) => [line.seq, line.message])).toEqual([
      [2, 'b'],
      [3, 'c'],
    ])
    expect(page.last_seq).toBe(3)
  })

  it('redacts secrets in the message and the fields', () => {
    const logs = new RunnerLogs()
    logs.sink(
      record('token ghp_abcdefghijklmnopqrstuvwxyz0123', {
        attributes: { authorization: 'Bearer abc', task: 'o/r#1' },
        traceId: 't1',
      }),
    )
    const [line] = logs.page().lines
    expect(line?.message).toBe('token ghp_[REDACTED]')
    expect(line?.fields).toBe('authorization=[REDACTED] task=o/r#1')
    expect(line?.trace_id).toBe('t1')
  })

  it('returns the newest lines that pass the filter, up to the limit', () => {
    const logs = new RunnerLogs()
    logs.sink(record('uno', { level: 'debug' }))
    logs.sink(record('dos', { level: 'error' }))
    logs.sink(record('tres', { level: 'warn' }))
    expect(logs.page({ level: 'warn' }).lines.map((line) => line.message)).toEqual(['dos', 'tres'])
    expect(logs.page({ limit: 1 }).lines.map((line) => line.message)).toEqual(['tres'])
    expect(logs.page({ after: 3 }).lines).toEqual([])
  })
})
