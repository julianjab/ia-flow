import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BashRunTool } from '../BashRunTool.js'

/** Un `git` falso primero en el PATH: imprime el argv que recibió, uno por línea. */
function fakeGitPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-git-'))
  const bin = join(dir, 'git')
  writeFileSync(bin, '#!/bin/sh\nfor a in "$@"; do echo "$a"; done\n')
  chmodSync(bin, 0o755)
  return `${dir}:${process.env.PATH ?? ''}`
}

function tool(gitCredential?: () => Promise<string | undefined>) {
  return new BashRunTool({
    baseDir: mkdtempSync(join(tmpdir(), 'cred-')),
    policy: { deny: [] },
    env: { PATH: fakeGitPath() },
    gitCredential,
  })
}

const header = (token: string) =>
  `http.https://github.com/.extraHeader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`

const PUSH = ['git', 'push', 'origin', 'HEAD:ia-flow/7'].join(' ')

describe('BashRunTool — gitCredential', () => {
  it('gives a network git the GitHub-scoped header, with hooks off, before the subcommand', async () => {
    const out = await tool(async () => 'tok').handler({ command: PUSH })
    expect(out).toContain(header('tok'))
    expect(out).toContain('core.hooksPath=/dev/null')
    expect(out.indexOf('extraHeader')).toBeLessThan(out.indexOf('push'))
    for (const command of [
      'git fetch origin',
      'git pull --ff-only origin main',
      'git ls-remote origin',
    ]) {
      expect(await tool(async () => 'tok').handler({ command }), command).toContain('extraHeader')
    }
  })

  it('keeps it out of non-network git (commit runs its hooks without the token)', async () => {
    const t = tool(async () => 'tok')
    for (const command of ['git commit -m x', 'git status', 'git diff HEAD']) {
      const out = await t.handler({ command })
      expect(out, command).not.toContain('extraHeader')
      expect(out, command).not.toContain('hooksPath')
    }
  })

  it('asks for the token on every network command (tokens rotate)', async () => {
    let calls = 0
    const t = tool(async () => `tok-${++calls}`)
    await t.handler({ command: 'git fetch origin' })
    expect(await t.handler({ command: 'git fetch origin' })).toContain(header('tok-2'))
  })

  it('never touches non-git commands, nor git without a credential configured', async () => {
    expect(await tool(async () => 'tok').handler({ command: 'echo git fetch' })).not.toContain(
      'extraHeader',
    )
    expect(await tool().handler({ command: PUSH })).not.toContain('extraHeader')
  })

  it('runs without the header when no token is available, instead of failing', async () => {
    expect(
      await tool(async () => undefined).handler({ command: 'git fetch origin' }),
    ).not.toContain('extraHeader')
    const failing = tool(async () => {
      throw new Error('sin red')
    })
    expect(await failing.handler({ command: 'git fetch origin' })).not.toContain('extraHeader')
  })

  it('rejects the git forms that could read or divert the credential', async () => {
    const t = tool(async () => 'tok')
    for (const command of [
      'git var -l',
      'git -C /tmp status',
      'git --git-dir=/tmp/x status',
      'git --exec-path=/tmp status',
      'git log --work-tree=/tmp',
      'git --namespace x fetch',
      'git push --receive-pack=sh /tmp/x',
      'git ls-remote -u./x.sh .',
    ]) {
      // Algunas (`--exec-path`) ya las rechaza la policy de siempre; lo que importa es que ninguna
      // corra con la credencial.
      await expect(t.handler({ command }), command).rejects.toThrow(/bash_run:/)
    }
  })
})
