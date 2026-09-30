import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TranscriptMessage } from '../TranscriptAssembler.js'
import { TranscriptTail } from '../TranscriptTail.js'

const line = (id: string, output: number, text?: string) =>
  `${JSON.stringify({
    type: 'assistant',
    message: {
      id,
      model: 'claude-opus-5',
      usage: { output_tokens: output },
      content: text ? [{ type: 'text', text }] : [],
    },
  })}\n`
const user = `${JSON.stringify({ type: 'user', message: { content: 'ok' } })}\n`

let dir: string
let path: string
let seen: TranscriptMessage[]
let tail: TranscriptTail

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'transcript-tail-'))
  path = join(dir, 'session.jsonl')
  seen = []
  tail = new TranscriptTail({ onMessage: (message) => seen.push(message) })
})
afterEach(() => rm(dir, { recursive: true, force: true }))

describe('TranscriptTail', () => {
  it('emits each message as soon as it is complete, reading only what is new', async () => {
    await writeFile(path, line('m1', 5, 'hola') + user)
    await tail.read(path)
    expect(seen.map((m) => m.id)).toEqual(['m1'])

    await appendFile(path, line('m2', 3))
    await tail.read(path)
    // m2 puede seguir creciendo: todavía no sale.
    expect(seen.map((m) => m.id)).toEqual(['m1'])

    await appendFile(path, line('m2', 30) + user)
    await tail.read(path)
    expect(seen.map((m) => [m.id, m.usage.outputTokens])).toEqual([
      ['m1', 5],
      ['m2', 30],
    ])
  })

  it('waits for the rest of a half-written line', async () => {
    const full = line('m1', 5) + user
    await writeFile(path, full.slice(0, 20))
    await tail.read(path)
    await appendFile(path, full.slice(20))
    await tail.read(path)
    expect(seen.map((m) => m.id)).toEqual(['m1'])
  })

  it('flush (Stop / end of run) emits the message still open', async () => {
    await writeFile(path, line('m1', 5))
    await tail.read(path, { flush: true })
    expect(seen.map((m) => m.id)).toEqual(['m1'])

    await appendFile(path, line('m2', 1))
    await tail.read(path)
    await tail.finish()
    expect(seen.map((m) => m.id)).toEqual(['m1', 'm2'])
  })

  it('serializes concurrent reads: parallel hooks never emit twice', async () => {
    await writeFile(path, line('m1', 5) + user + line('m2', 1) + user)
    await Promise.all([tail.read(path), tail.read(path), tail.read(path)])
    expect(seen.map((m) => m.id)).toEqual(['m1', 'm2'])
  })

  it('a missing transcript or a throwing observer never fails', async () => {
    await expect(tail.read(join(dir, 'nope.jsonl'), { flush: true })).resolves.toBeUndefined()
    const throwing = new TranscriptTail({
      onMessage: () => {
        throw new Error('boom')
      },
    })
    await writeFile(path, line('m1', 5))
    await expect(throwing.read(path, { flush: true })).resolves.toBeUndefined()
  })
})
