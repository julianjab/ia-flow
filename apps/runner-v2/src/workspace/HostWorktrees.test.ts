import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ShellResult, ShellRunner } from '@ia-flow/workspace'
import { HostWorktrees } from './HostWorktrees.js'

const ok = (stdout = ''): ShellResult => ({ exitCode: 0, stdout, stderr: '' })

interface FakeTree {
  /** `HEAD` = separado. */
  branch: string
  dirty?: boolean
  /** HEAD separado: si alguna branch remota lo contiene. Default: sí. */
  onRemote?: boolean
  refuse?: boolean
}

/** Un git de mentira: cada worktree con su branch (o HEAD separado) y su estado. */
function fakeGit(trees: Record<string, FakeTree>) {
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
      if (cmd === 'git branch -r --contains HEAD') {
        return ok(tree?.onRemote === false ? '' : '  origin/task/7\n')
      }
      if (cmd.startsWith('git worktree remove ')) {
        const path = argv[3] as string
        if (trees[path]?.refuse) {
          return { exitCode: 1, stdout: '', stderr: 'contains modified files' }
        }
        removed.push(path)
        return ok()
      }
      throw new Error(`comando inesperado: ${cmd} en ${cwd}`)
    },
  }
  return { shell, removed }
}

describe('HostWorktrees', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'host-worktrees-'))
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  function worktrees(
    git: { shell: ShellRunner },
    over: {
      safe?: (path: string) => boolean | Promise<boolean>
      exists?: (path: string) => boolean
    } = {},
  ) {
    const lines: string[] = []
    const checked: string[] = []
    const w = new HostWorktrees({
      shell: git.shell,
      workspace: {
        isWorktreeSafeToRemove: async (path, branch) => {
          checked.push(`${path}@${branch}`)
          return over.safe ? over.safe(path) : true
        },
      },
      log: {
        info: (line) => lines.push(`info ${line}`),
        warn: (line) => lines.push(`warn ${line}`),
        error: (line) => lines.push(`error ${line}`),
      },
      ledgerPath: join(dir, 'host-worktrees.json'),
      exists: over.exists ?? (() => true),
    })
    return { w, lines, checked }
  }

  describe('al terminar la corrida', () => {
    it('terminó OK con todo en el remoto: el worktree se borra', async () => {
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
      const { w, lines } = worktrees(git, { safe: () => false })
      const path = await w.begin(async () => '/wt/task-7')
      expect(await w.end(path, 'done')).toBe('kept-unpushed')
      expect(git.removed).toEqual([])
      expect(lines.some((l) => l.startsWith('error ') && l.includes('terminó OK'))).toBe(true)
    })

    it('pausado (wait_for_event): queda, la conversación sigue en ese directorio', async () => {
      const git = fakeGit({ '/wt/task-7': { branch: 'task/7' } })
      const { w, checked } = worktrees(git)
      const path = await w.begin(async () => '/wt/task-7')
      expect(await w.end(path, 'paused')).toBe('kept-paused')
      expect(git.removed).toEqual([])
      expect(checked).toEqual([])
    })

    it('falló o la sesión terminó sola: se borra si está limpio; con trabajo afuera queda (warn)', async () => {
      const git = fakeGit({ '/wt/clean': { branch: 'task/1' }, '/wt/dirty': { branch: 'task/2' } })
      const { w, lines } = worktrees(git, { safe: (path) => path === '/wt/clean' })
      await w.begin(async () => '/wt/clean')
      await w.end('/wt/clean', 'failed')
      await w.begin(async () => '/wt/dirty')
      await w.end('/wt/dirty', undefined)
      expect(git.removed).toEqual(['/wt/clean'])
      expect(lines.some((l) => l.startsWith('warn ') && l.includes('/wt/dirty'))).toBe(true)
      expect(lines.some((l) => l.startsWith('error '))).toBe(false)
    })

    it('HEAD separado (un carril, o un rebase a medias): limpio no alcanza, el remoto tiene que tener HEAD', async () => {
      const git = fakeGit({
        '/wt/task-7--e2e': { branch: 'HEAD' },
        '/wt/task-7--dirty': { branch: 'HEAD', dirty: true },
        // Commits que ninguna branch tiene (un rebase que quedó a mitad): se perderían.
        '/wt/task-7--rebasing': { branch: 'HEAD', onRemote: false },
      })
      const { w, checked } = worktrees(git)
      for (const path of ['/wt/task-7--e2e', '/wt/task-7--dirty', '/wt/task-7--rebasing']) {
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

    it('una corrida que pide el worktree mientras se chequea si se puede borrar: no se borra', async () => {
      const git = fakeGit({ '/wt/a': { branch: 'task/1' } })
      let release!: () => void
      const checking = new Promise<void>((resolve) => {
        release = resolve
      })
      const { w } = worktrees(git, { safe: () => checking.then(() => true) })
      await w.begin(async () => '/wt/a')
      const ending = w.end('/wt/a', 'done')
      const begun = w.begin(async () => '/wt/a')
      release()
      expect(await ending).toBe('kept-in-use')
      expect(await begun).toBe('/wt/a')
      expect(git.removed).toEqual([])
    })

    it('una corrida que empieza mientras un borrado ya se ejecuta lo espera antes de armar', async () => {
      const git = fakeGit({ '/wt/a': { branch: 'HEAD' } })
      let release!: () => void
      const removing = new Promise<void>((resolve) => {
        release = resolve
      })
      const slow: ShellRunner = {
        run: async (argv, cwd) => {
          if (argv[1] === 'worktree' && argv[2] === 'remove') await removing
          return git.shell.run(argv, cwd)
        },
      }
      const { w } = worktrees({ shell: slow })
      const order: string[] = []
      await w.begin(async () => '/wt/a')
      const ending = w.end('/wt/a', 'done').then((fate) => {
        order.push('removed')
        return fate
      })
      await Bun.sleep(5)
      const begun = w.begin(async () => {
        order.push('prepare')
        return '/wt/a'
      })
      await Bun.sleep(5)
      release()
      expect(await ending).toBe('removed')
      await begun
      // Armó DESPUÉS del borrado: `prepare` lo vuelve a crear.
      expect(order).toEqual(['removed', 'prepare'])
    })
  })

  describe('sweep — el respaldo', () => {
    it('borra lo que armó y quedó limpio (una pausa que no volvió, un host que se cayó); lo demás queda', async () => {
      const git = fakeGit({
        '/wt/paused': { branch: 'task/1' },
        '/wt/crashed': { branch: 'HEAD' },
        '/wt/unpushed': { branch: 'task/3' },
      })
      const first = worktrees(git, { safe: (path) => path !== '/wt/unpushed' })
      await first.w.begin(async () => '/wt/paused')
      await first.w.end('/wt/paused', 'paused')
      // El host se cae con estas dos corridas a medias: `end` nunca corre.
      await first.w.begin(async () => '/wt/crashed')
      await first.w.begin(async () => '/wt/unpushed')

      // Arranca de nuevo: lee lo que armó.
      const second = worktrees(git, { safe: (path) => path !== '/wt/unpushed' })
      expect(await second.w.sweep()).toEqual(['/wt/paused', '/wt/crashed'])
      expect(second.lines.some((l) => l.startsWith('warn ') && l.includes('/wt/unpushed'))).toBe(
        true,
      )
      expect(JSON.parse(await readFile(join(dir, 'host-worktrees.json'), 'utf8'))).toEqual([
        '/wt/unpushed',
      ])
    })

    it('nunca toca un worktree que no armó (el de un runner en el mismo disco)', async () => {
      const git = fakeGit({ '/wt/del-runner': { branch: 'task/9' } })
      const { w } = worktrees(git)
      expect(await w.sweep()).toEqual([])
      expect(await w.end('/wt/del-runner', 'done')).toBe('kept-error')
      expect(git.removed).toEqual([])
    })

    it('olvida lo que ya no está en disco', async () => {
      const git = fakeGit({})
      const { w } = worktrees(git, { exists: () => false })
      await w.begin(async () => '/wt/gone')
      await w.end('/wt/gone', 'paused')
      expect(await w.sweep()).toEqual([])
      expect(JSON.parse(await readFile(join(dir, 'host-worktrees.json'), 'utf8'))).toEqual([])
    })

    it('nunca uno en uso, ni nada mientras una corrida arma su worktree', async () => {
      const git = fakeGit({ '/wt/a': { branch: 'task/1' }, '/wt/b': { branch: 'task/2' } })
      const { w } = worktrees(git)
      await w.begin(async () => '/wt/b')
      await w.end('/wt/b', 'paused')
      await w.begin(async () => '/wt/a')
      expect(await w.sweep()).toEqual(['/wt/b'])

      let release!: () => void
      const preparing = new Promise<string>((resolve) => {
        release = () => resolve('/wt/c')
      })
      const begun = w.begin(() => preparing)
      expect(await w.sweep()).toEqual([])
      release()
      await begun
    })
  })
})
