import { describe, expect, it } from 'vitest'
import { detectToolError, hookLogs, MAX_HOOK_BYTES } from '../hookTaxonomy.js'

const names = (event: string, input: Record<string, unknown>) =>
  hookLogs(event, input).map((log) => [log.level, log.message])

describe('detectToolError', () => {
  it('trusts only the explicit flags', () => {
    expect(detectToolError({ is_error: true })).toBe(true)
    expect(detectToolError({ isError: false })).toBe(false)
    expect(detectToolError({ success: false })).toBe(true)
    expect(detectToolError({ stderr: 'warning: algo', interrupted: false })).toBeUndefined()
    expect(detectToolError('texto')).toBeUndefined()
    expect(detectToolError([{ is_error: true }])).toBeUndefined()
  })
})

describe('hookLogs', () => {
  it('maps each hook to the v1 taxonomy', () => {
    expect(names('PreToolUse', { tool_name: 'Bash', tool_use_id: 't1' })).toEqual([
      ['debug', 'tool.pre'],
    ])
    expect(names('PreToolUse', { tool_name: 'Task', tool_use_id: 't2' })).toEqual([
      ['info', 'subagent.start'],
    ])
    expect(names('PostToolUse', { tool_name: 'Bash', tool_use_id: 't1' })).toEqual([
      ['info', 'tool.call'],
      ['info', 'tool.result'],
    ])
    expect(names('UserPromptSubmit', { prompt: 'hola' })).toEqual([['info', 'agent.prompt']])
    expect(names('Stop', {})).toEqual([['info', 'agent.stop']])
    expect(names('SubagentStop', {})).toEqual([['info', 'subagent.stop']])
    expect(names('SessionStart', { source: 'startup' })).toEqual([['info', 'agent.session_start']])
    expect(names('Notification', {})).toEqual([['debug', 'hook Notification']])
  })

  it('pairs tool.call and tool.result by use id, with the error flag only when explicit', () => {
    const [call, result] = hookLogs('PostToolUse', {
      tool_name: 'Edit',
      tool_use_id: 'toolu_1',
      tool_input: { file_path: 'a.ts' },
      tool_response: { success: false },
    })
    expect(call?.attributes).toMatchObject({
      'ia.hook.event': 'tool.call',
      'ia.hook.name': 'PostToolUse',
      'gen_ai.tool.name': 'Edit',
      'ia.tool.use_id': 'toolu_1',
      'ia.tool.input': '{"file_path":"a.ts"}',
    })
    expect(result?.attributes).toMatchObject({
      'ia.hook.event': 'tool.result',
      'ia.tool.use_id': 'toolu_1',
      'ia.tool.result': '{"success":false}',
      'ia.tool.is_error': true,
    })
    const [, unknown] = hookLogs('PostToolUse', { tool_name: 'Bash', tool_response: 'ok' })
    expect(unknown?.attributes).not.toHaveProperty('ia.tool.is_error')
  })

  it('describes a subagent launch and truncates big payloads to 10 KB', () => {
    const [start] = hookLogs('PreToolUse', {
      tool_name: 'Task',
      tool_input: { subagent_type: 'explorer', description: 'buscar', prompt: 'x'.repeat(20_000) },
    })
    expect(start?.attributes['ia.subagent.type']).toBe('explorer')
    expect(start?.attributes['ia.subagent.description']).toBe('buscar')
    expect(String(start?.attributes['ia.subagent.prompt']).length).toBeLessThan(MAX_HOOK_BYTES + 20)
  })
})
