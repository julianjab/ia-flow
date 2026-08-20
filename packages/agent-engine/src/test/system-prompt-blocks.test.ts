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

  test('resolves inline {text} entries directly, without a catalog lookup', () => {
    const blocks = resolveSystemPromptBlocks({ systemPrompts: [{ text: 'inline text' }] }, {})
    expect(blocks).toEqual([{ type: 'text', text: 'inline text' }])
  })

  test('mixes ids and inline text in the same array, preserving declared order', () => {
    const blocks = resolveSystemPromptBlocks(
      { systemPrompts: [{ text: 'first inline' }, 'a', { text: 'last inline' }] },
      { systemPrompts: [{ id: 'a', name: 'A', text: 'text A' }] },
    )
    expect(blocks).toEqual([
      { type: 'text', text: 'first inline' },
      { type: 'text', text: 'text A' },
      { type: 'text', text: 'last inline' },
    ])
  })

  test('includes the project-level defaults first, ids and inline mixed', () => {
    const blocks = resolveSystemPromptBlocks(
      {},
      {
        project: { systemPrompts: ['a', { text: 'project inline' }] },
        systemPrompts: [{ id: 'a', name: 'A', text: 'text A' }],
      },
    )
    expect(blocks).toEqual([
      { type: 'text', text: 'text A' },
      { type: 'text', text: 'project inline' },
    ])
  })

  test('includes any SystemPromptDef marked default without the agent listing it', () => {
    const blocks = resolveSystemPromptBlocks(
      {},
      { systemPrompts: [{ id: 'a', name: 'A', text: 'default text', default: true }] },
    )
    expect(blocks).toEqual([{ type: 'text', text: 'default text' }])
  })

  test('orders blocks as project refs, then default SystemPromptDefs, then agent refs', () => {
    const blocks = resolveSystemPromptBlocks(
      { systemPrompts: ['explicit'] },
      {
        project: { systemPrompts: [{ text: 'project default' }] },
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
    ])
  })

  test('does not duplicate a SystemPromptDef id referenced both as project default and explicitly by the agent', () => {
    const blocks = resolveSystemPromptBlocks(
      { systemPrompts: ['shared'] },
      {
        project: { systemPrompts: ['shared'] },
        systemPrompts: [{ id: 'shared', name: 'Shared', text: 'shared text' }],
      },
    )
    expect(blocks).toEqual([{ type: 'text', text: 'shared text' }])
  })

  test('does not duplicate a SystemPromptDef that is both default=true and explicitly listed by id', () => {
    const blocks = resolveSystemPromptBlocks(
      { systemPrompts: ['shared'] },
      { systemPrompts: [{ id: 'shared', name: 'Shared', text: 'shared text', default: true }] },
    )
    expect(blocks).toEqual([{ type: 'text', text: 'shared text' }])
  })
})
