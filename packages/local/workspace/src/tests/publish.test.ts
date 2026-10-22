/**
 * `publishBranch` con git REAL contra un repo bare local: lo que el agente commiteó y no pudo
 * pushear llega a `origin/<branch>`, sin pisar lo que otro pusheó y nunca a una branch protegida.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PipelineExecutionContext } from '@ia-flow/agent-engine'
import { beforeEach, describe, expect, it } from 'vitest'
import { PublishBranchAction } from '../actions/PublishBranchAction.js'
import type { WorkspaceSession } from '../actions/WorkspaceSession.js'
import { describePublish, publishBranch } from '../publish.js'
import { NodeShellRunner } from '../shell.js'

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim()

const commit = (cwd: string, file: string, text: string) => {
  writeFileSync(join(cwd, file), text)
  git(cwd, 'add', '.')
  git(cwd, 'commit', '-q', '-m', `${file}: ${text.trim()}`)
}

/** Un "GitHub" local con `main`, y el worktree de la task: un clone en `ia-flow/7`. */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'publish-'))
  const bare = join(dir, 'repo.git')
  const work = join(dir, 'work')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare])
  execFileSync('git', ['clone', '-q', bare, work])
  commit(work, 'README.md', 'base\n')
  git(work, 'push', '-q', 'origin', 'HEAD:main')
  git(work, 'remote', 'set-head', 'origin', 'main')
  git(work, 'checkout', '-q', '-b', 'ia-flow/7')
  return { dir, bare, work }
}

const remoteHas = (bare: string, branch: string) => {
  try {
    return execFileSync('git', ['rev-parse', `refs/heads/${branch}`], {
      cwd: bare,
      encoding: 'utf8',
    }).trim()
  } catch {
    return undefined
  }
}

const shell = new NodeShellRunner()

describe('publishBranch', () => {
  let repo: ReturnType<typeof setup>
  beforeEach(() => {
    repo = setup()
  })

  it('una branch que no existe en el remoto no se crea: puede ser la de un PR mergeado y borrado', async () => {
    commit(repo.work, 'feature.txt', 'v1\n')

    expect(await publishBranch(shell, [], repo.work, 'ia-flow/7')).toEqual({
      status: 'skipped',
      reason: 'origin/ia-flow/7 no existe',
    })
    expect(remoteHas(repo.bare, 'ia-flow/7')).toBeUndefined()
  })

  it('el commit del autosalvage no se publica: puede traer cualquier cosa del disco', async () => {
    git(repo.work, 'push', '-q', 'origin', 'ia-flow/7')
    commit(repo.work, 'feature.txt', 'v1\n')
    writeFileSync(join(repo.work, '.env.local'), 'SECRET=1\n')
    git(repo.work, 'add', '-A')
    git(repo.work, 'commit', '-q', '-m', 'WIP autosalvage from run r1')

    expect(await publishBranch(shell, [], repo.work, 'ia-flow/7')).toMatchObject({
      status: 'skipped',
    })
  })

  it('tampoco a la base del repo, aunque no se llame main', async () => {
    git(repo.work, 'push', '-q', 'origin', 'HEAD:trunk')
    git(repo.work, 'remote', 'set-head', 'origin', 'trunk')
    git(repo.work, 'checkout', '-q', '-b', 'trunk')

    expect(await publishBranch(shell, [], repo.work, 'trunk')).toEqual({
      status: 'skipped',
      reason: 'trunk es la base del repo',
    })
  })

  it('con la branch publicada, sube sólo lo que falta', async () => {
    commit(repo.work, 'feature.txt', 'v1\n')
    git(repo.work, 'push', '-q', 'origin', 'ia-flow/7')
    commit(repo.work, 'feature.txt', 'v2\n')
    commit(repo.work, 'feature.spec.txt', 'spec\n')

    expect(await publishBranch(shell, [], repo.work, 'ia-flow/7')).toEqual({
      status: 'pushed',
      commits: 2,
    })
  })

  it('todo publicado: no hace nada', async () => {
    commit(repo.work, 'feature.txt', 'v1\n')
    git(repo.work, 'push', '-q', 'origin', 'ia-flow/7')

    expect(await publishBranch(shell, [], repo.work, 'ia-flow/7')).toEqual({ status: 'up-to-date' })
  })

  it('si alguien pusheó en el medio, no pisa nada', async () => {
    commit(repo.work, 'feature.txt', 'v1\n')
    git(repo.work, 'push', '-q', 'origin', 'ia-flow/7')
    // Otra máquina publica en la branch…
    const other = join(repo.dir, 'other')
    execFileSync('git', ['clone', '-q', '-b', 'ia-flow/7', repo.bare, other])
    commit(other, 'human.txt', 'fix\n')
    git(other, 'push', '-q', 'origin', 'ia-flow/7')
    const theirs = remoteHas(repo.bare, 'ia-flow/7')
    // …y el agente commiteó lo suyo sin traerlo.
    commit(repo.work, 'feature.txt', 'v2\n')

    const result = await publishBranch(shell, [], repo.work, 'ia-flow/7')

    expect(result).toEqual({ status: 'diverged', behind: 1 })
    expect(remoteHas(repo.bare, 'ia-flow/7')).toBe(theirs)
    expect(describePublish('ia-flow/7', result)).toContain('no publiqué para no pisarlos')
  })

  it('nunca publica en una branch protegida, ni si HEAD está en otra', async () => {
    expect(await publishBranch(shell, [], repo.work, 'main')).toEqual({
      status: 'skipped',
      reason: 'main es protegida',
    })
    expect(await publishBranch(shell, [], repo.work, 'ia-flow/8')).toEqual({
      status: 'skipped',
      reason: 'HEAD está en ia-flow/7, no en ia-flow/8',
    })
  })

  it('lo sin commitear no se publica: sólo lo commiteado', async () => {
    git(repo.work, 'push', '-q', 'origin', 'ia-flow/7')
    const before = remoteHas(repo.bare, 'ia-flow/7')
    writeFileSync(join(repo.work, 'dirty.txt'), 'sin commit\n')

    expect(await publishBranch(shell, [], repo.work, 'ia-flow/7')).toEqual({ status: 'up-to-date' })
    expect(remoteHas(repo.bare, 'ia-flow/7')).toBe(before)
  })
})

describe('publish_branch', () => {
  const ctx = {} as PipelineExecutionContext
  const sessionWith = (prepared?: { path: string; branch: string }) =>
    ({
      prepared: () => (prepared ? Promise.resolve(prepared) : undefined),
      manager: { publishBranch: async () => ({ status: 'pushed', commits: 2 }) },
    }) as unknown as WorkspaceSession

  it('publica lo del worktree de la corrida y dice qué hizo', async () => {
    const action = new PublishBranchAction(sessionWith({ path: '/wt/7', branch: 'ia-flow/7' }))
    expect(await action.execute({}, ctx)).toBe('publiqué 2 commit(s) locales en origin/ia-flow/7')
  })

  it('sin worktree en el runner (no tocó disco, o corrió en un host) no hace nada', async () => {
    const action = new PublishBranchAction(sessionWith())
    expect(await action.execute({}, ctx)).toContain('Sin worktree de esta corrida en el runner')
  })
})
