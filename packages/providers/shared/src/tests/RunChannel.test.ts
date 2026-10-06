import type { Tool } from '@ia-flow/agent-engine'
import { captureContext } from '@ia-flow/telemetry'
import { describe, expect, it } from 'vitest'
import { handleMcp } from '../McpProtocol.js'
import { endingOf, RunChannel } from '../RunChannel.js'

const tool = (name: string, extra: Partial<Tool> = {}): Tool => ({
  name,
  description: `la tool ${name}`,
  inputSchema: { type: 'object' },
  handler: (input) => `${name}:${JSON.stringify(input)}`,
  ...extra,
})

function channel(inbox: string[] = [], maxStopNudges = 2) {
  return new RunChannel({
    agentId: 'implementer',
    tools: [
      tool('fs_read'),
      tool('submit_done', { terminal: true }),
      tool('fail_turn', { terminal: true, failure: true }),
      tool('broken', {
        handler: () => {
          throw new Error('se rompió')
        },
      }),
    ],
    inbox: () => inbox.splice(0),
    parent: captureContext(),
    maxStopNudges,
  })
}

describe('handleMcp', () => {
  it('answers initialize, lists the run tools and ignores notifications', async () => {
    const run = channel()
    expect(
      await handleMcp(run, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    ).toMatchObject({
      status: 200,
      body: { id: 1, result: { serverInfo: { name: 'ia-flow' }, capabilities: { tools: {} } } },
    })
    expect(await handleMcp(run, { jsonrpc: '2.0', method: 'notifications/initialized' })).toEqual({
      status: 202,
      body: null,
    })
    const list = await handleMcp(run, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    expect(
      (list.body as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name),
    ).toEqual(['fs_read', 'submit_done', 'fail_turn', 'broken'])
    expect(await handleMcp(run, { jsonrpc: '2.0', id: 3, method: 'nope' })).toMatchObject({
      body: { error: { code: -32601 } },
    })
  })

  it('runs a tool call, returns errors as isError, and a terminal tool ends the run', async () => {
    const run = channel()
    const call = (name: string, id: number) =>
      handleMcp(run, {
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name, arguments: { path: 'a' } },
      })

    expect((await call('fs_read', 1)).body).toMatchObject({
      result: { content: [{ type: 'text', text: 'fs_read:{"path":"a"}' }] },
    })
    expect((await call('broken', 2)).body).toMatchObject({
      result: { content: [{ text: 'se rompió' }], isError: true },
    })
    expect(run.finished).toBe(false)
    await call('submit_done', 3)
    expect(run.finished).toBe(true)
    await run.done
  })
})

describe('RunChannel hooks', () => {
  it('PostToolUse hands the inbox over as additional context, once', async () => {
    const inbox = ['un comentario nuevo']
    const run = channel(inbox)
    expect(await run.hook('PostToolUse', { tool_name: 'Bash', tool_use_id: 't1' })).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: '[Mensaje recibido mientras trabajabas]\nun comentario nuevo',
      },
    })
    expect(await run.hook('PostToolUse', { tool_name: 'Bash', tool_use_id: 't2' })).toEqual({})
  })

  it('Stop blocks while the turn is open (a few times), and always delivers what arrived', async () => {
    const inbox: string[] = []
    const run = channel(inbox, 2)
    const first = await run.hook('Stop', {})
    expect(first).toMatchObject({ decision: 'block' })
    expect(String(first.reason)).toContain('mcp__ia-flow__submit_done')
    expect(String(first.reason)).not.toContain('mcp__ia-flow__fail_turn,')
    expect(await run.hook('Stop', {})).toMatchObject({ decision: 'block' })
    expect(await run.hook('Stop', {})).toEqual({})

    inbox.push('pará')
    expect(await run.hook('Stop', {})).toEqual({
      decision: 'block',
      reason: '[Mensaje recibido mientras trabajabas]\npará',
    })
  })

  it('does not nudge once the turn is closed', async () => {
    const run = channel()
    await handleMcp(run, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'submit_done', arguments: {} },
    })
    expect(await run.hook('Stop', {})).toEqual({})
  })

  it('traces native tools between PreToolUse and PostToolUse without failing on strays', async () => {
    const run = channel()
    expect(
      await run.hook('PreToolUse', { tool_name: 'Edit', tool_use_id: 'x', tool_input: {} }),
    ).toEqual({})
    expect(await run.hook('PostToolUse', { tool_use_id: 'x', tool_response: 'ok' })).toEqual({})
    expect(await run.hook('PostToolUse', { tool_use_id: 'nunca-empezó' })).toEqual({})
    expect(await run.hook('SessionStart', {})).toEqual({})
    run.close()
  })
})

describe('cómo cerró el turno (RunEnding)', () => {
  it('una salida es `done`; fail_turn y yield_turn `failed`; wait_for_event `paused`', () => {
    expect(endingOf({ name: 'submit_done' })).toBe('done')
    expect(endingOf({ name: 'fail_turn', failure: true })).toBe('failed')
    expect(endingOf({ name: 'yield_turn', failure: true })).toBe('failed')
    expect(endingOf({ name: 'wait_for_event', failure: true })).toBe('paused')
  })

  it('el canal recuerda la primera tool terminal que llamó el modelo', async () => {
    const run = channel()
    expect(run.ending).toBeUndefined()
    await run.call('fs_read', {})
    expect(run.ending).toBeUndefined()
    await run.call('submit_done', {})
    await run.call('fail_turn', {})
    expect(run.ending).toBe('done')
    run.close()
  })
})
