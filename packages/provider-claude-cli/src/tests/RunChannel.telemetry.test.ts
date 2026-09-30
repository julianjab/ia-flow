import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addLogSink,
  captureContext,
  type LogRecord,
  withInheritedAttributes,
  withSpan,
} from '@ia-flow/telemetry'
import { context, ROOT_CONTEXT, trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { RunChannel } from '../RunChannel.js'

const spans = new InMemorySpanExporter()
const logs: LogRecord[] = []
let removeSink: () => void
let dir: string

beforeAll(async () => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] }),
  )
  removeSink = addLogSink((record) => logs.push(record))
  dir = await mkdtemp(join(tmpdir(), 'run-channel-'))
})
afterAll(async () => {
  removeSink()
  trace.disable()
  context.disable()
  await rm(dir, { recursive: true, force: true })
})
beforeEach(() => {
  spans.reset()
  logs.length = 0
})

/** Un canal colgado del span `agent implementer`, dentro de la ejecución `exec-1`. */
async function inAgent(
  fn: (channel: RunChannel, texts: string[]) => Promise<void>,
): Promise<string> {
  const texts: string[] = []
  let traceId = ''
  await withInheritedAttributes({ 'ia.execution.id': 'exec-1' }, () =>
    withSpan('agent implementer', {}, async (span) => {
      traceId = span.spanContext().traceId
      const channel = new RunChannel({
        agentId: 'implementer',
        tools: [],
        parent: captureContext(),
        maxStopNudges: 0,
        onText: (text) => texts.push(text),
      })
      await fn(channel, texts)
    }),
  )
  return traceId
}

const assistant = (id: string, output: number, text: string) =>
  `${JSON.stringify({
    type: 'assistant',
    message: {
      id,
      model: 'claude-opus-5',
      usage: {
        input_tokens: 3,
        output_tokens: output,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 10,
      },
      content: [{ type: 'text', text }],
    },
  })}\n`

describe('RunChannel — traza de los hooks', () => {
  it('logs every hook inside the agent trace, tagged with the execution', async () => {
    const traceId = await inAgent(async (channel) => {
      // Un hook llega por HTTP, fuera del contexto de la corrida.
      await context.with(ROOT_CONTEXT, async () => {
        channel.hook('PostToolUse', {
          tool_name: 'Bash',
          tool_use_id: 'toolu_1',
          tool_input: { command: 'ls' },
          tool_response: { is_error: true },
        })
        channel.hook('SessionStart', { session_id: 's1', source: 'startup' })
      })
      await channel.close()
    })

    expect(logs.map((log) => log.message)).toEqual([
      'tool.call',
      'tool.result',
      'agent.session_start',
    ])
    for (const log of logs) {
      expect(log.traceId).toBe(traceId)
      expect(log.attributes['ia.execution.id']).toBe('exec-1')
      expect(log.attributes['ia.agent.id']).toBe('implementer')
    }
    expect(logs[1]?.attributes).toMatchObject({
      'ia.tool.use_id': 'toolu_1',
      'ia.tool.is_error': true,
    })
  })

  it('turns each completed transcript message into a chat span as the hooks arrive', async () => {
    const path = join(dir, 'session.jsonl')
    const user = `${JSON.stringify({ type: 'user', message: { content: 'ok' } })}\n`
    let afterFirstHook: string[] = []
    const traceId = await inAgent(async (channel, texts) => {
      await writeFile(
        path,
        assistant('m1', 50, 'miro el repo') + user + assistant('m2', 7, 'listo'),
      )
      channel.hook('PreToolUse', { tool_name: 'Read', tool_use_id: 't', transcript_path: path })
      await channel.close()
      afterFirstHook = [...texts]
    })

    const chats = spans.getFinishedSpans().filter((span) => span.name === 'chat claude-opus-5')
    expect(chats).toHaveLength(2)
    expect(chats[0]?.attributes).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'anthropic',
      'gen_ai.request.model': 'claude-opus-5',
      'gen_ai.response.model': 'claude-opus-5',
      'gen_ai.usage.input_tokens': 3,
      'gen_ai.usage.output_tokens': 50,
      'gen_ai.usage.cache_read_input_tokens': 100,
      'gen_ai.usage.cache_creation_input_tokens': 10,
      'ia.execution.id': 'exec-1',
    })
    const agent = spans.getFinishedSpans().find((span) => span.name === 'agent implementer')
    for (const chat of chats) {
      expect(chat.spanContext().traceId).toBe(traceId)
      expect(chat.parentSpanContext?.spanId).toBe(agent?.spanContext().spanId)
    }
    expect(afterFirstHook).toEqual(['miro el repo', 'listo'])
  })

  it('emits a message on Stop, before the run closes', async () => {
    const path = join(dir, 'stop.jsonl')
    await inAgent(async (channel, texts) => {
      await writeFile(path, assistant('m1', 5, 'terminé'))
      channel.hook('Stop', { transcript_path: path })
      // La lectura es asíncrona: se espera sin cerrar el canal.
      for (let i = 0; i < 50 && texts.length === 0; i++) await new Promise((r) => setTimeout(r, 5))
      expect(texts).toEqual(['terminé'])
      await channel.close()
    })
  })
})
