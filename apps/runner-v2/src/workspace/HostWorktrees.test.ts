import { describe, expect, it } from 'bun:test'
import type { ShellResult, ShellRunner } from '@ia-flow/workspace'
import { HostWorktrees } from './HostWorktrees.js'

const ok = (stdout = ''): ShellResult => ({ exitCode: 0, stdout, stderr: '' })

/** Un git de mentira: cada worktree con su branch (o `HEAD` separado) y si está sucio. */
function fakeGit(trees: Record<string, { branch: string; dirty?: boolean; refuse?: boolean }>) {
  const removed: string[] = []
  const shell: ShellRunner = {
    run: async (argv, cwd) => {
      const cmd = argv.join(' ')
      const tree = cwd ? trees[cwd] : undefined
      if (cmd === 'git rev-parse --path-format=absolute --git-common-dir') {
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

function worktrees(
  git: ReturnType<typeof fakeGit>,
  safe: (path: string) => boolean | Promise<boolean> = () => true,
) {
  const lines: string[] = []
  const checked: string[] = []
  const w = new HostWorktrees({
    shell: git.shell,
    workspace: {
      isWorktreeSafeToRemove: async (path, branch) => {
        checked.push(`${path}@${branch}`)
        return safe(path)
      },
    },
    log: {
      info: (line) => lines.push(`info ${line}`),
      warn: (line) => lines.push(`warn ${line}`),
      error: (line) => lines.push(`error ${line}`),
    },
  })
  return { w, lines, checked }
}

describe('HostWorktrees', () => {
  it('el agente terminó OK con todo en el remoto: el worktree se borra al terminar', async () => {
    const git = fakeGit({ '/wt/task-7': { branch: 'task/7' } })
    const { w, checked } = worktrees(git)
    const path = await w.begin(async () => '/wt/task-7')
    expect(await w.end(path, 'done')).toBe('removed')
    expect(git.removed).toEqual(['/wt/task-7'])
    // Con branch: se mira que no quede nada sin commitear ni sin pushear.
    expect(checked).toEqual(['/wt/task-7@task/7'])
  })

  it('terminó OK pero dejó trabajo afuera del remoto: queda en disco y es un error', async () => {
    const git = fakeGit({ '/wt/task-7': { branch: 'task/7' } })
    const { w, lines } = worktrees(git, () => false)
    const path = await w.begin(async () => '/wt/task-7')
    expect(await w.end(path, 'done')).toBe('kept-unpushed')
    expect(git.removed).toEqual([])
    expect(lines.some((line) => line.startsWith('error ') && line.includes('terminó OK'))).toBe(
      true,
    )
  })

  it('pausado (wait_for_event): queda, la conversación sigue en ese directorio', async () => {
    const git = fakeGit({ '/wt/task-7': { branch: 'task/7' } })
    const { w, checked } = worktrees(git)
    const path = await w.begin(async () => '/wt/task-7')
    expect(await w.end(path, 'paused')).toBe('kept-paused')
    expect(git.removed).toEqual([])
    expect(checked).toEqual([])
  })

  it('falló o la sesión terminó sola: se borra si está limpio; con trabajo sin pushear queda (warn)', async () => {
    const git = fakeGit({
      '/wt/clean': { branch: 'task/1' },
      '/wt/dirty': { branch: 'task/2' },
    })
    const { w, lines } = worktrees(git, (path) => path === '/wt/clean')
    for (const [path, ending] of [
      ['/wt/clean', 'failed'],
      ['/wt/dirty', undefined],
    ] as const) {
      await w.begin(async () => path)
      await w.end(path, ending)
    }
    expect(git.removed).toEqual(['/wt/clean'])
    expect(lines.some((line) => line.startsWith('warn ') && line.includes('/wt/dirty'))).toBe(true)
    expect(lines.some((line) => line.startsWith('error '))).toBe(false)
  })

  it('un carril (HEAD separado) se borra si está limpio; sucio, queda', async () => {
    const git = fakeGit({
      '/wt/task-7--e2e': { branch: 'HEAD' },
      '/wt/task-7--reviewer': { branch: 'HEAD', dirty: true },
    })
    const { w, checked } = worktrees(git)
    for (const path of ['/wt/task-7--e2e', '/wt/task-7--reviewer']) {
      await w.begin(async () => path)
      await w.end(path, 'done')
    }
    expect(git.removed).toEqual(['/wt/task-7--e2e'])
    expect(checked).toEqual([])
  })

  it('git se niega a borrarlo: queda, sin romper la corrida', async () => {
    const git = fakeGit({ '/wt/a': { branch: 'HEAD', refuse: true } })
    const { w } = worktrees(git)
    await w.begin(async () => '/wt/a')
    expect(await w.end('/wt/a', 'done')).toBe('kept-error')
  })

  it('nunca borra uno que otra corrida está usando', async () => {
    const git = fakeGit({ '/wt/a': { branch: 'task/1' } })
    const { w } = worktrees(git)
    await w.begin(async () => '/wt/a')
    await w.begin(async () => '/wt/a')
    expect(await w.end('/wt/a', 'done')).toBe('kept-in-use')
    expect(await w.end('/wt/a', 'done')).toBe('removed')
  })

  it('una corrida que pide el worktree mientras otra lo borra espera y lo vuelve a armar', async () => {
    const git = fakeGit({ '/wt/a': { branch: 'task/1' } })
    let release!: () => void
    const checking = new Promise<void>((resolve) => {
      release = resolve
    })
    const { w } = worktrees(git, () => checking.then(() => true))
    await w.begin(async () => '/wt/a')
    const ending = w.end('/wt/a', 'done')

    // Mientras se chequea, la task vuelve a correr y pide el mismo worktree (todavía existe).
    let prepared = 0
    const begun = w.begin(async () => {
      prepared++
      return '/wt/a'
    })
    release()

    // O no se borró (lo tomó a tiempo), o se borró y la corrida lo volvió a armar.
    const fate = await ending
    expect(await begun).toBe('/wt/a')
    expect(fate === 'kept-in-use' || prepared === 2).toBe(true)
  })
})
