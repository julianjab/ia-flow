/**
 * Publicar los commits locales de un worktree que el agente no pudo pushear (lh-seller-v2-frontend
 * #4392: el MCP de GitHub perdió la auth a mitad de la corrida y el código validado quedó en un
 * commit local; hicieron falta tres corridas para que el PR existiera). Lo hace quien administra el
 * worktree, con sus propias credenciales, al cerrar la corrida.
 *
 * Sólo lo ya commiteado —nunca commitea un árbol sucio, ni publica el commit del autosalvage—, sin
 * `--force`, sobre una branch que ya existe en el remoto y nunca a una protegida ni a la base. Si
 * `origin/<branch>` tiene commits que la local no (alguien pusheó en el medio), no pisa nada: lo
 * dice y la próxima corrida lo resuelve.
 */
import { PROTECTED_BRANCHES } from './layout.js'
import type { ShellRunner } from './shell.js'

export type PublishResult =
  | { status: 'pushed'; commits: number }
  | { status: 'up-to-date' }
  | { status: 'diverged'; behind: number }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; error: string }

const count = (stdout: string) => stdout.split('\n').filter((line) => line.trim()).length

/** El mensaje del commit que arma el autosalvage al reusar un worktree sucio (`git add -A`): puede
 *  traer cualquier cosa que quedó en disco, así que nunca se publica solo. */
const AUTOSALVAGE = 'WIP autosalvage'

/** La base del repo (`origin/HEAD` → `main`, `trunk`…): tampoco se publica ahí, aunque no esté en
 *  `PROTECTED_BRANCHES`. */
async function baseBranch(shell: ShellRunner, worktreePath: string): Promise<string | undefined> {
  const head = await shell.run(
    ['git', 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
    worktreePath,
  )
  return head.exitCode === 0 ? head.stdout.trim().replace(/^origin\//, '') : undefined
}

/** Publica en `origin/<branch>` lo que HEAD tiene y el remoto no. `auth` son los `-c` de git con la
 *  credencial (vacío sin una). Sólo sobre una branch que YA existe en el remoto (la vincula
 *  `link_branch` al arrancar la tarea): una que no está puede ser la de un PR mergeado y borrado, y
 *  publicarla la resucitaría. */
export async function publishBranch(
  shell: ShellRunner,
  auth: string[],
  worktreePath: string,
  branch: string,
): Promise<PublishResult> {
  if (PROTECTED_BRANCHES.has(branch)) return { status: 'skipped', reason: `${branch} es protegida` }
  const head = await shell.run(['git', 'symbolic-ref', '--quiet', '--short', 'HEAD'], worktreePath)
  if (head.exitCode !== 0) return { status: 'skipped', reason: 'HEAD no está en una branch' }
  if (head.stdout.trim() !== branch) {
    return { status: 'skipped', reason: `HEAD está en ${head.stdout.trim()}, no en ${branch}` }
  }
  if ((await baseBranch(shell, worktreePath)) === branch) {
    return { status: 'skipped', reason: `${branch} es la base del repo` }
  }

  const listed = await shell.run(
    ['git', ...auth, 'ls-remote', '--exit-code', 'origin', `refs/heads/${branch}`],
    worktreePath,
  )
  if (listed.exitCode === 2) return { status: 'skipped', reason: `origin/${branch} no existe` }
  if (listed.exitCode !== 0) {
    return { status: 'failed', error: `no se pudo leer origin/${branch}: ${listed.stderr.trim()}` }
  }
  // Lo que el remoto tiene AHORA: sin esto, un `origin/<branch>` rancio haría parecer adelantado
  // algo que ya está publicado, o esconder que alguien pusheó en el medio.
  const fetched = await shell.run(
    [
      'git',
      ...auth,
      'fetch',
      '--quiet',
      'origin',
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ],
    worktreePath,
  )
  if (fetched.exitCode !== 0) {
    return {
      status: 'failed',
      error: `no se pudo traer origin/${branch}: ${fetched.stderr.trim()}`,
    }
  }

  const remote = `origin/${branch}`
  const ahead = await shell.run(['git', 'log', '--format=%s', `${remote}..HEAD`], worktreePath)
  if (ahead.exitCode !== 0) return { status: 'failed', error: ahead.stderr.trim() }
  const subjects = ahead.stdout.split('\n').filter((line) => line.trim())
  if (subjects.length === 0) return { status: 'up-to-date' }
  if (subjects.some((subject) => subject.startsWith(AUTOSALVAGE))) {
    return { status: 'skipped', reason: `hay un commit "${AUTOSALVAGE}" sin revisar en el rango` }
  }
  const behind = await shell.run(['git', 'rev-list', `HEAD..${remote}`], worktreePath)
  if (behind.exitCode !== 0) return { status: 'failed', error: behind.stderr.trim() }
  if (count(behind.stdout) > 0) return { status: 'diverged', behind: count(behind.stdout) }

  const pushed = await shell.run(
    ['git', ...auth, 'push', 'origin', `HEAD:refs/heads/${branch}`],
    worktreePath,
  )
  if (pushed.exitCode !== 0)
    return { status: 'failed', error: (pushed.stderr || pushed.stdout).trim() }
  return { status: 'pushed', commits: subjects.length }
}

/** Una línea para el log y la traza. */
export function describePublish(branch: string, result: PublishResult): string {
  switch (result.status) {
    case 'pushed':
      return `publiqué ${result.commits} commit(s) locales en origin/${branch}`
    case 'up-to-date':
      return `origin/${branch} ya tenía todo lo commiteado`
    case 'diverged':
      return `origin/${branch} tiene ${result.behind} commit(s) que la local no: no publiqué para no pisarlos`
    case 'skipped':
      return `no publiqué: ${result.reason}`
    case 'failed':
      return `no pude publicar en origin/${branch}: ${result.error}`
  }
}
