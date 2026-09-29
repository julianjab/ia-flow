import { describe, expect, it } from 'bun:test'
import { parseArgs, parseIssueTarget } from '../cli.js'

describe('parseArgs', () => {
  it('without a mode, it only boots and validates', () => {
    expect(parseArgs([])).toEqual({ serve: false })
    expect(parseArgs(['--config', '/x'])).toEqual({ serve: false, configDir: '/x' })
  })

  it('a raw webhook from a file, or a real PR', () => {
    expect(parseArgs(['--event', 'github.issue_comment', './d.json']).event).toEqual({
      type: 'github.issue_comment',
      payloadPath: './d.json',
    })
    expect(parseArgs(['--replay-pr', 'la-haus/x#3'])).toMatchObject({ replayPr: 'la-haus/x#3' })
    for (const gone of ['--live', '--dry-run']) {
      expect(() => parseArgs([gone])).toThrow(/argumento desconocido/)
    }
  })

  it('does not build events: no event names without github., no event flags', () => {
    expect(() => parseArgs(['--event', 'issue.created', './d.json'])).toThrow(/github\.<evento>/)
    expect(() => parseArgs(['issue.created', 'la-haus/x#3'])).toThrow(/argumento desconocido/)
    expect(() => parseArgs(['--status', 'Build'])).toThrow(/argumento desconocido/)
  })

  it('one mode at a time', () => {
    expect(() => parseArgs(['--serve', '--replay-pr', 'a/b#1'])).toThrow(/van de a uno/)
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
