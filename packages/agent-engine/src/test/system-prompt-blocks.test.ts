import { describe, expect, test } from 'bun:test'
import { resolveSystemPromptBlocks } from '../system-prompt-blocks.js'

describe('resolveSystemPromptBlocks', () => {
  test('returns no blocks when nothing is configured', () => {
    expect(resolveSystemPromptBlocks({}, {})).toEqual([])
  })

  test('resolves an id from AgentDefinition.systemPrompts against ProjectConfig.systemPrompts', () => {
    const blocks = resolveSystemPromptBlocks(
      { systemPrompts: ['a'] },
      { systemPrompts: [{ id: 'a', name: 'A', text: 'text A' }] },
    )
    expect(blocks).toEqual([{ type: 'text', text: 'text A' }])
  })

  test('ignores an id with no matching SystemPromptDef', () => {
    const blocks = resolveSystemPromptBlocks(
      { systemPrompts: ['missing'] },
      { systemPrompts: [{ id: 'a', name: 'A', text: 'text A' }] },
    )
    expect(blocks).toEqual([])
  })

  test('includes the project-level default first', () => {
    const blocks = resolveSystemPromptBlocks({}, { project: { systemPrompt: 'project rules' } })
    expect(blocks).toEqual([{ type: 'text', text: 'project rules' }])
  })

  test('includes any SystemPromptDef marked default without the agent listing it', () => {
    const blocks = resolveSystemPromptBlocks(
      {},
      { systemPrompts: [{ id: 'a', name: 'A', text: 'default text', default: true }] },
    )
    expect(blocks).toEqual([{ type: 'text', text: 'default text' }])
  })

  test('appends inlineSystemPrompt last', () => {
    const blocks = resolveSystemPromptBlocks(
      { systemPrompts: ['a'], inlineSystemPrompt: 'agent-specific text' },
      {
        project: { systemPrompt: 'project rules' },
        systemPrompts: [{ id: 'a', name: 'A', text: 'text A' }],
      },
    )
    expect(blocks).toEqual([
      { type: 'text', text: 'project rules' },
      { type: 'text', text: 'text A' },
      { type: 'text', text: 'agent-specific text' },
    ])
  })

  test('orders blocks as project default, then default SystemPromptDefs, then explicit ids, then inline', () => {
    const blocks = resolveSystemPromptBlocks(
      { systemPrompts: ['explicit'], inlineSystemPrompt: 'inline text' },
      {
        project: { systemPrompt: 'project default' },
        systemPrompts: [
          { id: 'auto', name: 'Auto', text: 'auto default', default: true },
          { id: 'explicit', name: 'Explicit', text: 'explicit text' },
        ],
      },
    )
    expect(blocks).toEqual([
      { type: 'text', text: 'project default' },
      { type: 'text', text: 'auto default' },
      { type: 'text', text: 'explicit text' },
      { type: 'text', text: 'inline text' },
    ])
  })

  test('does not duplicate a SystemPromptDef that is both default=true and explicitly listed by id', () => {
    const blocks = resolveSystemPromptBlocks(
      { systemPrompts: ['shared'] },
      { systemPrompts: [{ id: 'shared', name: 'Shared', text: 'shared text', default: true }] },
    )
    expect(blocks).toEqual([{ type: 'text', text: 'shared text' }])
  })
})
