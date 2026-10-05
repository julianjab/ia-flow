import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ShellResult, ShellRunner } from '@ia-flow/workspace'
import { WorktreeSweeper } from './WorktreeSweeper.js'

const HOUR = 3_600_000
const ok = (stdout = ''): ShellResult => ({ exitCode: 0, stdout, stderr: '' })

/** Un git de mentira: cada worktree con su branch (o HEAD separado) y si está sucio. */
function fakeGit(trees: Record<string, { branch: string; dirty?: boolean; refuse?: boolean }>) {
  const removed: string[] = []
  const shell: ShellRunner = {
    run: async (argv, cwd) => {
      const cmd = argv.join(' ')
      const tree = cwd ? trees[cwd] : undefined
      if (cmd.startsWith('git rev-parse --path-format=absolute --git-common-dir')) {
        return tree ? ok('/repos/eks/.git\n') : { exitCode: 128, stdout: '', stderr: 'not a git' }
      }
      if (cmd === 'git rev-parse --abbrev-ref HEAD') return ok(`${tree?.branch}\n`)
      if (cmd === 'git status --porcelain') return ok(tree?.dirty ? ' M a.ts\n' : '')
      if (cmd.startsWith('git worktree remove ')) {
        const path = argv[3] as string
        if (trees[path]?.refuse)
          return { exitCode: 1, stdout: '', stderr: 'contains modified files' }
        removed.push(path)
        return ok()
      }
      throw new Error(`comando inesperado: ${cmd} en ${cwd}`)
    },
  }
  return { shell, removed }
}

describe('WorktreeSweeper', () => {
  let dir: string
  let now: number
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sweeper-'))
    now = 1_000 * HOUR
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  function sweeper(
    git: ReturnType<typeof fakeGit>,
    over: {
      safe?: (path: string) => boolean | Promise<boolean>
      exists?: (path: string) => boolean
    } = {},
  ) {
    const checked: string[] = []
    const s = new WorktreeSweeper({
      shell: git.shell,
      workspace: {
        isWorktreeSafeToRemove: async (path, branch) => {
          checked.push(`${path}@${branch}`)
          return over.safe ? over.safe(path) : true
        },
      },
      ledgerPath: join(dir, 'host-worktrees.json'),
      ttlMs: 72 * HOUR,
      now: () => now,
      exists: over.exists ?? (() => true),
      log: () => {},
    })
    return { s, checked }
  }

  it('borra sólo lo que pasó el TTL sin uso; lo reciente queda', async () => {
    const git = fakeGit({ '/wt/old': { branch: 'task/1' }, '/wt/new': { branch: 'task/2' } })
    const { s, checked } = sweeper(git)
    await s.begin(async () => '/wt/old')
    s.end('/wt/old')
    now += 70 * HOUR
    await s.begin(async () => '/wt/new')
    s.end('/wt/new')
    now += 3 * HOUR

    expect(await s.sweep()).toEqual(['/wt/old'])
    expect(git.removed).toEqual(['/wt/old'])
    // Con branch: el chequeo de trabajo sin pushear.
    expect(checked).toEqual(['/wt/old@task/1'])
  })

  it('nunca borra uno en uso, aunque haya pasado el TTL', async () => {
    const git = fakeGit({ '/wt/a': { branch: 'task/1' } })
    const { s } = sweeper(git)
    await s.begin(async () => '/wt/a')
    await s.begin(async () => '/wt/a')
    now += 100 * HOUR
    expect(await s.sweep()).toEqual([])
    // Dos corridas en el mismo: sigue en uso hasta que terminen las dos.
    s.end('/wt/a')
    now += 100 * HOUR
    expect(await s.sweep()).toEqual([])
    s.end('/wt/a')
    now += 100 * HOUR
    expect(await s.sweep()).toEqual(['/wt/a'])
  })

  it('no borra uno con trabajo sin pushear, ni un carril sucio, ni lo que git se niega a borrar', async () => {
    const git = fakeGit({
      '/wt/unpushed': { branch: 'task/1' },
      '/wt/lane': { branch: 'HEAD', dirty: true },
      '/wt/refused': { branch: 'HEAD', refuse: true },
    })
    const { s } = sweeper(git, { safe: (path) => path !== '/wt/unpushed' })
    for (const path of ['/wt/unpushed', '/wt/lane', '/wt/refused']) {
      await s.begin(async () => path)
      s.end(path)
    }
    now += 100 * HOUR
    expect(await s.sweep()).toEqual([])
    expect(git.removed).toEqual([])
  })

  it('un carril limpio (HEAD separado) se borra sin preguntar por su branch', async () => {
    const git = fakeGit({ '/wt/eks-7--e2e': { branch: 'HEAD' } })
    const { s, checked } = sweeper(git)
    await s.begin(async () => '/wt/eks-7--e2e')
    s.end('/wt/eks-7--e2e')
    now += 100 * HOUR
    expect(await s.sweep()).toEqual(['/wt/eks-7--e2e'])
    expect(checked).toEqual([])
  })

  it('recuerda entre reinicios, y olvida lo que ya no existe en disco', async () => {
    const git = fakeGit({ '/wt/a': { branch: 'task/1' } })
    const first = sweeper(git).s
    await first.begin(async () => '/wt/a')
    first.end('/wt/a')
    await first.begin(async () => '/wt/gone')
    first.end('/wt/gone')
    now += 100 * HOUR

    // Otro proceso (el host se reinició): lee lo anotado.
    const second = sweeper(git, { exists: (path) => path !== '/wt/gone' }).s
    expect(await second.sweep()).toEqual(['/wt/a'])
    expect(JSON.parse(await readFile(join(dir, 'host-worktrees.json'), 'utf8'))).toEqual({})
  })

  it('una corrida que retoma un worktree vencido mientras el sweep lo chequea: no se borra', async () => {
    const git = fakeGit({ '/wt/a': { branch: 'task/1' } })
    let release!: () => void
    const checking = new Promise<void>((resolve) => {
      release = resolve
    })
    const { s } = sweeper(git, { safe: () => checking.then(() => true) })
    await s.begin(async () => '/wt/a')
    s.end('/wt/a')
    now += 100 * HOUR

    // El sweep pasó el chequeo de uso y está esperando a git…
    const swept = s.sweep()
    // …y justo ahí la task vuelve a correr y pide el mismo worktree.
    const order: string[] = []
    const begun = s.begin(async () => {
      order.push('prepare')
      return '/wt/a'
    })
    release()

    expect(await swept).toEqual([])
    expect(await begun).toBe('/wt/a')
    expect(git.removed).toEqual([])
    // La corrida esperó a que el sweep terminara antes de armar su worktree.
    expect(order).toEqual(['prepare'])
  })

  it('lo que no anotó no lo toca', async () => {
    const git = fakeGit({ '/wt/ajeno': { branch: 'task/9' } })
    const { s } = sweeper(git)
    now += 1_000 * HOUR
    expect(await s.sweep()).toEqual([])
    expect(git.removed).toEqual([])
  })
})
