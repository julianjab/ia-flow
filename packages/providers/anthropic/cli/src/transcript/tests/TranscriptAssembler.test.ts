import { describe, expect, it } from 'vitest'
import { TranscriptAssembler, type TranscriptMessage } from '../TranscriptAssembler.js'
import { parseTranscriptLine } from '../transcriptLine.js'

function assistant(
  id: string | undefined,
  model: string,
  usage: Record<string, number>,
  extra: { text?: string; timestamp?: string; sidechain?: boolean } = {},
): string {
  return JSON.stringify({
    type: 'assistant',
    ...(extra.timestamp ? { timestamp: extra.timestamp } : {}),
    ...(extra.sidechain ? { isSidechain: true } : {}),
    message: {
      ...(id ? { id } : {}),
      model,
      usage,
      content: extra.text ? [{ type: 'text', text: extra.text }] : [{ type: 'tool_use', id: 't' }],
    },
  })
}
const user = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hola' } })

function all(lines: string[], since?: Date): TranscriptMessage[] {
  const assembler = new TranscriptAssembler(since)
  return [...lines.flatMap((line) => assembler.push(line)), ...assembler.flush()]
}

describe('parseTranscriptLine', () => {
  it('reads the usage, model and text of an assistant line', () => {
    expect(
      parseTranscriptLine(
        assistant(
          'm1',
          'claude-sonnet-5',
          {
            input_tokens: 10,
            output_tokens: 100,
            cache_read_input_tokens: 1000,
            cache_creation_input_tokens: 500,
          },
          { text: 'hola', timestamp: '2026-01-01T00:00:00Z' },
        ),
      ),
    ).toEqual({
      kind: 'assistant',
      id: 'm1',
      model: 'claude-sonnet-5',
      usage: {
        inputTokens: 10,
        outputTokens: 100,
        cacheReadTokens: 1000,
        cacheCreationTokens: 500,
      },
      texts: ['hola'],
      timestamp: '2026-01-01T00:00:00Z',
      sidechain: false,
    })
  })

  it('ignores broken or empty lines, and anything else is "other"', () => {
    expect(parseTranscriptLine('{no json')).toBeUndefined()
    expect(parseTranscriptLine('   ')).toBeUndefined()
    expect(parseTranscriptLine(user)).toEqual({ kind: 'other' })
  })
})

describe('TranscriptAssembler', () => {
  it('one message per request, with its usage', () => {
    const messages = all([
      user,
      assistant('m1', 'claude-sonnet-5', { input_tokens: 10, output_tokens: 100 }),
      assistant('m2', 'claude-sonnet-5', { input_tokens: 5, output_tokens: 50 }),
    ])
    expect(messages.map((m) => [m.id, m.usage.inputTokens, m.usage.outputTokens])).toEqual([
      ['m1', 10, 100],
      ['m2', 5, 50],
    ])
  })

  it('dedupes the lines that repeat the same message (one per block), keeping the last usage', () => {
    const messages = all([
      assistant('m1', 'claude-opus-5', { output_tokens: 3 }, { text: 'primero' }),
      assistant('m1', 'claude-opus-5', { output_tokens: 400 }),
      assistant('m1', 'claude-opus-5', { output_tokens: 400 }, { text: 'después' }),
    ])
    expect(messages).toHaveLength(1)
    expect(messages[0]?.usage.outputTokens).toBe(400)
    expect(messages[0]?.texts).toEqual(['primero', 'después'])
  })

  it('keeps the last message open until something else arrives, or flush', () => {
    const assembler = new TranscriptAssembler()
    expect(assembler.push(assistant('m1', 'claude-opus-5', { output_tokens: 1 }))).toEqual([])
    expect(assembler.push(assistant('m1', 'claude-opus-5', { output_tokens: 9 }))).toEqual([])
    expect(assembler.push(user).map((m) => m.usage.outputTokens)).toEqual([9])
    expect(assembler.push(assistant('m2', 'claude-opus-5', { output_tokens: 2 }))).toEqual([])
    expect(assembler.flush().map((m) => m.id)).toEqual(['m2'])
    expect(assembler.flush()).toEqual([])
  })

  it('never emits a message twice, even if a stray line names it again', () => {
    const messages = all([
      assistant('m1', 'claude-opus-5', { output_tokens: 1 }),
      user,
      assistant('m1', 'claude-opus-5', { output_tokens: 1 }),
    ])
    expect(messages.map((m) => m.id)).toEqual(['m1'])
  })

  it('ignores broken lines and assistant lines without usage', () => {
    expect(all(['{no json', '', '{ oops'])).toEqual([])
    const messages = all([
      '{ oops',
      JSON.stringify({ type: 'assistant', message: { id: 'x' } }),
      assistant('m1', 'claude-sonnet-5', { output_tokens: 7 }),
    ])
    expect(messages.map((m) => m.usage.outputTokens)).toEqual([7])
  })

  it('a message without id is its own message', () => {
    const messages = all([
      assistant(undefined, 'claude-haiku-4-5', { output_tokens: 1 }),
      assistant(undefined, 'claude-haiku-4-5', { output_tokens: 2 }),
    ])
    expect(messages.map((m) => m.usage.outputTokens)).toEqual([1, 2])
  })

  it('skips what was written before the run started (a resumed session)', () => {
    const messages = all(
      [
        assistant(
          'old',
          'claude-opus-5',
          { output_tokens: 1 },
          { timestamp: '2026-01-01T00:00:00Z' },
        ),
        assistant(
          'new',
          'claude-opus-5',
          { output_tokens: 2 },
          { timestamp: '2026-01-02T00:00:00Z' },
        ),
      ],
      new Date('2026-01-01T12:00:00Z'),
    )
    expect(messages.map((m) => m.id)).toEqual(['new'])
  })

  it('marks a subagent (sidechain) message', () => {
    const [message] = all([
      assistant('s', 'claude-haiku-4-5', { output_tokens: 1 }, { sidechain: true }),
    ])
    expect(message?.sidechain).toBe(true)
  })
})
