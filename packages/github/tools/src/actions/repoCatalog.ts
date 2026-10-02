/**
 * Lo que las tools de GitHub de un proyecto comparten: el cliente con la identidad del runner, el
 * board (Project v2) y el catálogo de repos. El `repo` que el modelo nombra se resuelve contra
 * ESE catálogo — un agente sólo crea o enlaza issues en repos que el proyecto declara, nunca en
 * uno que se le ocurra.
 */
import type { GithubClient } from '@ia-flow/github-api'
import type { BoardAdder } from '../board/types.js'

export interface GithubProjectContext {
  client: GithubClient
  /** El dueño del board es el dueño por defecto de los repos del catálogo que no declaran otro. */
  board: { owner: string; number: number }
  /** Cómo entra un issue al board; sin esto, el de un Project v2 (`board`). */
  adder?: BoardAdder
  repos: Array<{ name: string; githubOwner?: string; githubRepo?: string }>
}

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

/** `owner/repo` de un repo del catálogo, por su nombre en el catálogo o por su nombre en GitHub. */
export function resolveRepo(
  project: GithubProjectContext,
  name: string,
): { owner: string; repo: string } {
  const declared = project.repos.find((r) => r.name === name || r.githubRepo === name)
  const owner = declared?.githubOwner ?? project.board.owner
  const repo = declared?.githubRepo ?? declared?.name
  if (!declared || !repo) {
    const known = project.repos.map((r) => r.name).join(', ')
    throw new Error(`el repo "${name}" no está en el catálogo del proyecto (hay: ${known})`)
  }
  if (!SAFE_SEGMENT.test(owner) || !SAFE_SEGMENT.test(repo)) {
    throw new Error(`owner/repo inválidos: ${owner}/${repo}`)
  }
  return { owner, repo }
}
