import { describe, expect, it } from 'bun:test'
import { parseArgs, parseIssueTarget } from './cli.js'

describe('parseArgs', () => {
  it('without a mode, it only boots and validates', () => {
    expect(parseArgs([])).toEqual({ serve: false, host: false })
    expect(parseArgs(['--config', '/x/runner.local.yaml'])).toEqual({
      serve: false,
      host: false,
      config: '/x/runner.local.yaml',
    })
  })

  it('--host lends the local providers to other runners', () => {
    expect(parseArgs(['--host'])).toEqual({ serve: false, host: true })
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
    // `--status`/`--label` sólo simulan sobre un issue real (`--issue`): el webhook crudo.
    expect(() => parseArgs(['--status', 'Build'])).toThrow(/van con --issue/)
    expect(() => parseArgs(['--label', 'e2e-test'])).toThrow(/van con --issue/)
  })

  it('--issue simulates a column or a label on a real issue, as someone', () => {
    expect(parseArgs(['--issue', 'la-haus/x#3', '--status', 'Review']).issue).toEqual({
      ref: 'la-haus/x#3',
      change: { status: 'Review' },
      as: 'ia-flow-cli',
    })
    expect(
      parseArgs(['--issue', 'la-haus/x#3', '--label', 'e2e-test', '--as', 'julian']).issue,
    ).toEqual({ ref: 'la-haus/x#3', change: { label: 'e2e-test' }, as: 'julian' })
    // Sin `--issue`, la clave ni aparece.
    expect(parseArgs([])).not.toHaveProperty('issue')
  })

  it('--issue needs a valid ref and exactly one of --status / --label', () => {
    expect(() => parseArgs(['--issue', 'no-es-un-ref', '--status', 'Review'])).toThrow(
      /no es <owner>\/<repo>#<n>/,
    )
    expect(() => parseArgs(['--issue', 'la-haus/x#3'])).toThrow(/uno de los dos/)
    expect(() =>
      parseArgs(['--issue', 'la-haus/x#3', '--status', 'Review', '--label', 'e2e-test']),
    ).toThrow(/uno de los dos/)
  })

  it('one mode at a time', () => {
    expect(() => parseArgs(['--serve', '--replay-pr', 'a/b#1'])).toThrow(/van de a uno/)
    expect(() => parseArgs(['--serve', '--host'])).toThrow(/van de a uno/)
    expect(() => parseArgs(['--serve', '--issue', 'a/b#1', '--status', 'Review'])).toThrow(
      /van de a uno/,
    )
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
