import { describe, expect, it } from 'bun:test'
import { isBashCommandAllowed, matchesBashPattern } from '../pattern.js'

describe('matchesBashPattern', () => {
  it('matches an exact command', () => {
    expect(matchesBashPattern(['git', 'status'], 'git status')).toBe(true)
    expect(matchesBashPattern(['git', 'status'], 'git log')).toBe(false)
  })

  it('token-suffix wildcard prefix-matches a single token', () => {
    expect(matchesBashPattern(['git', 'log'], 'git log*')).toBe(true)
    expect(matchesBashPattern(['git', 'log', '--oneline'], 'git log*')).toBe(false)
    expect(matchesBashPattern(['npm', 'run'], 'npm run*')).toBe(true)
  })

  it('bare "*" token matches any single token', () => {
    expect(matchesBashPattern(['git', 'push', 'origin'], 'git * origin')).toBe(true)
    expect(matchesBashPattern(['git', 'pull', 'origin'], 'git * origin')).toBe(true)
    expect(matchesBashPattern(['git', 'push', 'upstream'], 'git * origin')).toBe(false)
  })

  it('trailing bare "*" consumes the rest of the command', () => {
    expect(matchesBashPattern(['npm', 'run', 'test:unit', '--', '--watch'], 'npm run *')).toBe(true)
    expect(matchesBashPattern(['npm', 'run'], 'npm run *')).toBe(true)
    expect(matchesBashPattern(['npm', 'test'], 'npm run *')).toBe(false)
  })

  it('requires exact token count when the pattern has no trailing wildcard', () => {
    expect(matchesBashPattern(['git', 'status', '--short'], 'git status')).toBe(false)
    expect(matchesBashPattern(['git'], 'git status')).toBe(false)
  })

  it('empty pattern never matches', () => {
    expect(matchesBashPattern(['git', 'status'], '')).toBe(false)
    expect(matchesBashPattern(['git', 'status'], '   ')).toBe(false)
  })
})

describe('isBashCommandAllowed', () => {
  it('rejects when nothing in allow matches', () => {
    expect(isBashCommandAllowed(['rm', '-rf', '/'], { allow: ['git *'], deny: [] })).toBe(false)
  })

  it('accepts when an allow pattern matches and nothing denies it', () => {
    expect(
      isBashCommandAllowed(['git', 'push', 'origin', 'task/x'], {
        allow: ['git push origin task/*'],
        deny: [],
      }),
    ).toBe(true)
  })

  it('deny wins over an overlapping allow', () => {
    const config = { allow: ['git push *'], deny: ['git push origin main*'] }
    expect(isBashCommandAllowed(['git', 'push', 'origin', 'task/x'], config)).toBe(true)
    expect(isBashCommandAllowed(['git', 'push', 'origin', 'main'], config)).toBe(false)
  })

  it('empty allow list rejects everything regardless of deny', () => {
    expect(isBashCommandAllowed(['git', 'status'], { allow: [], deny: [] })).toBe(false)
  })
})
