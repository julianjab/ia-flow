import { describe, expect, it } from 'bun:test'
import { parseArgs, parseIssueTarget } from '../cli.js'

describe('parseArgs', () => {
  it('without anything, it only boots and validates', () => {
    expect(parseArgs([])).toEqual({ dryRun: false, live: false, serve: false })
    expect(parseArgs(['--dry-run', '--config', '/x'])).toMatchObject({
      dryRun: true,
      configDir: '/x',
    })
  })

  it('a raw webhook from a file, or a real PR', () => {
    expect(parseArgs(['--event', 'github.issue_comment', './d.json']).event).toEqual({
      type: 'github.issue_comment',
      payloadPath: './d.json',
    })
    expect(parseArgs(['--live', '--replay-pr', 'la-haus/x#3'])).toMatchObject({
      live: true,
      replayPr: 'la-haus/x#3',
    })
  })

  it('does not build events: no event names without github., no event flags', () => {
    expect(() => parseArgs(['--event', 'issue.created', './d.json'])).toThrow(/github\.<evento>/)
    expect(() => parseArgs(['issue.created', 'la-haus/x#3'])).toThrow(/argumento desconocido/)
    expect(() => parseArgs(['--status', 'Build'])).toThrow(/argumento desconocido/)
  })

  it('one mode at a time, and none of them in dry-run: they read GitHub', () => {
    expect(() => parseArgs(['--serve', '--replay-pr', 'a/b#1'])).toThrow(/van de a uno/)
    expect(() => parseArgs(['--serve', '--dry-run'])).toThrow(/no admiten --dry-run/)
  })
})

describe('parseIssueTarget', () => {
  it('reads the usual ways to paste an issue or PR', () => {
    const target = { owner: 'la-haus', repo: 'eks', number: 9575 }
    expect(parseIssueTarget('la-haus/eks#9575')).toEqual(target)
    expect(parseIssueTarget('https://github.com/la-haus/eks/issues/9575')).toEqual(target)
    expect(parseIssueTarget('https://github.com/la-haus/eks/pull/9575')).toEqual(target)
    expect(parseIssueTarget('eks')).toBeUndefined()
  })
})
