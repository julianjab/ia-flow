import { afterEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findTranscript, forwardTranscript } from '../providers/transcriptForwarder.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function projects(sessionId: string, lines: unknown[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ia-flow-transcript-'))
  dirs.push(root)
  const folder = join(root, '-Users-julian-work-eks')
  await mkdir(folder)
  await writeFile(
    join(folder, `${sessionId}.jsonl`),
    `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`,
  )
  return root
}

const assistant = (id: string, text: string) => ({
  type: 'assistant',
  timestamp: new Date(Date.now() + 1_000).toISOString(),
  message: {
    id,
    model: 'claude-opus',
    content: [{ type: 'text', text }],
    usage: { input_tokens: 7, output_tokens: 3 },
  },
})

describe('findTranscript', () => {
  it('finds the session file by its id in any project folder', async () => {
    const root = await projects('s1', [])
    expect(await findTranscript('s1', root)).toBe(join(root, '-Users-julian-work-eks', 's1.jsonl'))
    expect(await findTranscript('otra', root)).toBeUndefined()
    expect(await findTranscript('s1', join(root, 'no-existe'))).toBeUndefined()
  })
})

describe('forwardTranscript', () => {
  it("posts the session's model requests to the runner when it stops", async () => {
    const root = await projects('s1', [assistant('m1', 'hola'), { type: 'user', message: {} }])
    const bodies: unknown[] = []
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)))
      return new Response('{}')
    }) as unknown as typeof fetch
    const forwarder = forwardTranscript({
      url: 'https://runner/v1/runs/tk/transcript',
      sessionId: 's1',
      since: new Date(Date.now() - 60_000),
      projectsDir: root,
      fetchImpl,
      pollMs: 60_000,
    })
    await forwarder.stop()
    expect(bodies).toEqual([
      {
        messages: [
          expect.objectContaining({
            id: 'm1',
            model: 'claude-opus',
            texts: ['hola'],
            usage: expect.objectContaining({ inputTokens: 7, outputTokens: 3 }),
          }),
        ],
      },
    ])
  })

  it('never throws when the runner is down or the transcript is missing', async () => {
    const root = await projects('s1', [assistant('m1', 'hola')])
    const down = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    await forwardTranscript({
      url: 'https://runner/x',
      sessionId: 's1',
      since: new Date(Date.now() - 60_000),
      projectsDir: root,
      fetchImpl: down,
      pollMs: 60_000,
    }).stop()
    await forwardTranscript({
      url: 'https://runner/x',
      sessionId: 'sin-transcripcion',
      projectsDir: root,
      fetchImpl: down,
      pollMs: 60_000,
    }).stop()
  })
})
