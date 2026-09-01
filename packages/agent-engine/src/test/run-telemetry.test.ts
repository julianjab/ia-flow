import { afterEach, describe, expect, it } from 'bun:test'
import {
  peekRunTelemetry,
  recordHookToolResult,
  recordHookTranscript,
  resetRunTelemetry,
  setTranscriptUsageReader,
  takeRunTelemetry,
} from '../run-telemetry.js'

afterEach(() => {
  resetRunTelemetry()
  setTranscriptUsageReader(undefined)
})

describe('run-telemetry', () => {
  it('cuenta llamadas y errores en total y por tool', () => {
    recordHookToolResult('r1', false, { toolName: 'Bash' })
    recordHookToolResult('r1', true, { toolName: 'Bash' })
    recordHookToolResult('r1', undefined, { toolName: 'Read' })

    expect(peekRunTelemetry('r1')).toEqual({
      toolCalls: 3,
      toolErrors: 1,
      toolBreakdown: { Bash: { calls: 2, errors: 1 }, Read: { calls: 1, errors: 0 } },
    })
  })

  it('lee la transcripción al consumir, no al recibir el path', () => {
    const seen: string[] = []
    setTranscriptUsageReader((path) => {
      seen.push(path)
      return {
        usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4 },
        model: 'claude-sonnet-5',
      }
    })
    recordHookToolResult('r1', false, { toolName: 'Bash', transcriptPath: '/t/a.jsonl' })
    expect(seen).toEqual([])

    const taken = takeRunTelemetry('r1')
    expect(seen).toEqual(['/t/a.jsonl'])
    expect(taken?.usage?.cacheReadTokens).toBe(3)
    expect(taken?.model).toBe('claude-sonnet-5')
    // Consumido: una segunda lectura no encuentra nada.
    expect(takeRunTelemetry('r1')).toBeUndefined()
  })

  it('un hook sin tool result también puede dejar el path', () => {
    setTranscriptUsageReader(() => ({
      usage: { inputTokens: 0, outputTokens: 9, cacheReadTokens: 0, cacheCreationTokens: 0 },
    }))
    recordHookTranscript('r2', '/t/b.jsonl')
    expect(takeRunTelemetry('r2')?.usage?.outputTokens).toBe(9)
  })

  it('un lector que tira degrada a sin usage, no voltea el cierre', () => {
    setTranscriptUsageReader(() => {
      throw new Error('disk')
    })
    recordHookToolResult('r3', false, { toolName: 'Bash', transcriptPath: '/t/c.jsonl' })
    const taken = takeRunTelemetry('r3')
    expect(taken?.toolCalls).toBe(1)
    expect(taken?.usage).toBeUndefined()
  })

  it('sin lector cableado el path no hace nada', () => {
    recordHookToolResult('r4', false, { toolName: 'Bash', transcriptPath: '/t/d.jsonl' })
    expect(takeRunTelemetry('r4')?.usage).toBeUndefined()
  })
})
