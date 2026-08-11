import { describe, expect, it } from 'bun:test'
import { addBlockedBy, addBlocks, parseBlockedBy, parseBlocks } from './blocked-by.js'

describe('parseBlockedBy', () => {
  it('returns [] when section absent', () => {
    expect(parseBlockedBy('# Task\n\nSome body.')).toEqual([])
  })

  it('reads bullet IDs under a Blocked by section', () => {
    const md = ['## Objetivo', 'foo', '', '## Blocked by', '- task-abc', '- task-def'].join('\n')
    expect(parseBlockedBy(md)).toEqual(['task-abc', 'task-def'])
  })

  it('accepts optional # prefix', () => {
    const md = '## Blocked by\n- #task-abc\n- task-def'
    expect(parseBlockedBy(md)).toEqual(['task-abc', 'task-def'])
  })

  it('stops at the next heading', () => {
    const md = ['## Blocked by', '- task-abc', '', '## Next', '- ignored'].join('\n')
    expect(parseBlockedBy(md)).toEqual(['task-abc'])
  })

  it('is case-insensitive on the heading', () => {
    expect(parseBlockedBy('## blocked by\n- x')).toEqual(['x'])
  })
})

describe('addBlockedBy', () => {
  it('creates the section at EOF when missing', () => {
    const out = addBlockedBy('# Task\n\nBody.', 'blk-1')
    expect(out).toContain('## Blocked by')
    expect(parseBlockedBy(out)).toEqual(['blk-1'])
  })

  it('appends to existing section', () => {
    const md = '# T\n\n## Blocked by\n- blk-1\n'
    const out = addBlockedBy(md, 'blk-2')
    expect(parseBlockedBy(out)).toEqual(['blk-1', 'blk-2'])
  })

  it('is idempotent for duplicates', () => {
    const md = '## Blocked by\n- blk-1\n'
    expect(addBlockedBy(md, 'blk-1')).toBe(md)
  })

  it('preserves content after the section', () => {
    const md = '## Blocked by\n- blk-1\n\n## Notes\n- keep me\n'
    const out = addBlockedBy(md, 'blk-2')
    expect(out).toContain('## Notes')
    expect(out).toContain('- keep me')
    expect(parseBlockedBy(out)).toEqual(['blk-1', 'blk-2'])
  })
})

describe('parseBlocks / addBlocks', () => {
  it('returns [] when section absent', () => {
    expect(parseBlocks('# Task\n\nBody')).toEqual([])
  })

  it('creates the ## Blocks section at EOF when missing', () => {
    const out = addBlocks('# T\n', 'child-1')
    expect(out).toContain('## Blocks')
    expect(parseBlocks(out)).toEqual(['child-1'])
  })

  it('is independent from ## Blocked by parsing', () => {
    const md = '## Blocked by\n- x\n\n## Blocks\n- y\n'
    expect(parseBlockedBy(md)).toEqual(['x'])
    expect(parseBlocks(md)).toEqual(['y'])
  })

  it('is idempotent for duplicates', () => {
    const md = '## Blocks\n- child-1\n'
    expect(addBlocks(md, 'child-1')).toBe(md)
  })
})
