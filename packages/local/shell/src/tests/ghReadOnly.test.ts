import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BashRunTool } from '../BashRunTool.js'
import { ghReadOnlyRisk } from '../ghReadOnly.js'
import { tokenize } from '../tokenize.js'

const risk = (command: string) => ghReadOnlyRisk(tokenize(command))

describe('ghReadOnlyRisk', () => {
  it.each([
    'gh run view 123 --log-failed',
    'gh run view 123 --log --job 456 --repo la-haus/subscriptions',
    'gh run view 123 --json conclusion,jobs --jq .jobs',
    'gh run list --branch refactor/migrate-ims-gates-to-core --limit 5 -R la-haus/subscriptions',
    'gh pr checks 1765 --required',
    'gh pr view 1765 --comments',
  ])('allows %s', (command) => expect(risk(command)).toBeUndefined())

  it.each([
    'gh auth token',
    'gh auth status',
    'gh api repos/la-haus/subscriptions/issues -X POST',
    'gh run rerun 123',
    'gh run delete 123',
    'gh run download 123',
    'gh pr merge 1765',
    'gh pr checkout 1765',
    'gh secret list',
    'gh alias set x y',
    'gh extension install a/b',
    'gh',
  ])('rejects %s', (command) => expect(risk(command)).toBeDefined())

  it('never lets the token reach another host', () => {
    expect(risk('gh run view 123 --repo evil.com/o/r')).toContain('owner/repo')
    expect(risk('gh run view https://evil.com/o/r/actions/runs/1')).toBeDefined()
    expect(risk('gh run view 123 --hostname evil.com')).toBeDefined()
    expect(risk('gh run view 123 --repo=o/r')).toBeDefined()
    expect(risk('gh run view 123 --web')).toBeDefined()
  })
})

/** Un `gh` falso primero en el PATH: imprime su argv y si le llegó GH_TOKEN. */
function fakeGhPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-gh-'))
  const bin = join(dir, 'gh')
  writeFileSync(bin, '#!/bin/sh\necho "token=${GH_TOKEN:-none} host=${GH_HOST:-none}"\necho "$@"\n')
  chmodSync(bin, 0o755)
  return `${dir}:${process.env.PATH ?? ''}`
}

function tool(gitCredential?: () => Promise<string | undefined>) {
  return new BashRunTool({
    baseDir: mkdtempSync(join(tmpdir(), 'gh-')),
    policy: { deny: [] },
    env: { PATH: fakeGhPath() },
    gitCredential,
  })
}

describe('BashRunTool — gh con credencial', () => {
  it('gives GH_TOKEN to an allowed read-only gh', async () => {
    const out = await tool(async () => 'tok').handler({ command: 'gh run view 9 --log-failed' })
    expect(out).toContain('token=tok host=github.com')
  })

  it('rejects any other gh before spawning it', async () => {
    const t = tool(async () => 'tok')
    for (const command of ['gh auth token', 'gh api user', 'gh pr merge 1']) {
      await expect(t.handler({ command }), command).rejects.toThrow(/gh con credencial/)
    }
  })

  it('does not hand the token to other commands', async () => {
    expect(await tool(async () => 'tok').handler({ command: 'env' })).not.toContain('tok')
  })

  it('runs without credential (and without restrictions) when none is configured', async () => {
    expect(await tool().handler({ command: 'gh auth status' })).toContain('token=none')
  })
})
