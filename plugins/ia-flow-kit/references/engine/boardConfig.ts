/**
 * El `board:` de un proyecto en `project.yaml`: de qué es (un GitHub Project v2 o los issues de sus
 * repos) y cómo se identifica. La implementación de cada uno vive en `src/board/`.
 */
import { z } from 'zod'

/**
 * Un board que son los issues de los repos del catálogo del proyecto (`repos/`): el estado de cada
 * uno vive en sus labels (`status:build`). Sin Project v2: funciona con el token de una GitHub App.
 */
export const IssuesBoardSchema = z.strictObject({
  kind: z.literal('issues'),
  /** Las columnas, en orden de avance. Sin ellas, cualquier `<statusPrefix>…` es una columna. */
  statuses: z.array(z.string().min(1)).min(1).optional(),
  /** El prefijo de los labels de columna. Default: `status:`. */
  statusPrefix: z.string().min(1).optional(),
})
export type IssuesBoardConfig = z.infer<typeof IssuesBoardSchema>

/** El board del proyecto: un GitHub Project v2 —`https://github.com/orgs/<org>/projects/<n>`, o el
 *  de una cuenta personal: `https://github.com/users/<login>/projects/<n>`— o los issues de sus
 *  repos (`{ kind: issues }`). */
export const BoardSchema = z.union([
  z
    .string()
    .regex(
      /github\.com\/(?:orgs|users)\/[^/]+\/projects\/\d+/,
      'un GitHub Project v2 (de org o de usuario) o { kind: issues }',
    ),
  IssuesBoardSchema,
])
export type BoardFile = z.infer<typeof BoardSchema>

/** Lo que el runner sabe del board de un proyecto una vez leído. */
export interface ProjectBoard {
  /** Cómo se identifica el board. Un Project v2: su dueño y número (`ownerKind`, el segmento de la
   *  URL: `orgs` o `users`). Uno de issues no tiene número (0) y su dueño es el del primer repo. */
  board: { owner: string; number: number; ownerKind?: 'orgs' | 'users' }
  /** De qué es el board: un Project v2 de GitHub o los issues de sus repos. */
  boardKind: 'projects-v2' | 'issues'
  /** Sólo con `boardKind: issues`: las columnas y el prefijo de sus labels. */
  issuesBoard?: { statuses?: string[]; statusPrefix?: string }
}

/** Los repos del catálogo, en lo que un board de issues necesita de ellos. */
interface CatalogRepo {
  name: string
  githubOwner?: string | undefined
  githubRepo?: string | undefined
}

function parseProjectUrl(url: string): ProjectBoard['board'] {
  const match = url.match(/github\.com\/(orgs|users)\/([^/]+)\/projects\/(\d+)/) as RegExpMatchArray
  return {
    owner: match[2] as string,
    number: Number(match[3]),
    ownerKind: match[1] as 'orgs' | 'users',
  }
}

/** El board de un proyecto: el Project v2 de su URL, o —`kind: issues`— los repos del catálogo. */
export function readBoard(board: BoardFile, repos: CatalogRepo[], where: string): ProjectBoard {
  if (typeof board === 'string') {
    return { board: parseProjectUrl(board), boardKind: 'projects-v2' }
  }
  const first = repos[0]
  if (!first) throw new Error(`${where}: board: { kind: issues } necesita algún repo en \`repos\``)
  const missing = repos.find((repo) => !repo.githubOwner || !repo.githubRepo)
  if (missing) {
    throw new Error(
      `${where}: board: { kind: issues } necesita githubOwner y githubRepo en cada repo (falta en "${missing.name}")`,
    )
  }
  return {
    board: { owner: first.githubOwner as string, number: 0 },
    boardKind: 'issues',
    issuesBoard: {
      ...(board.statuses ? { statuses: board.statuses } : {}),
      ...(board.statusPrefix ? { statusPrefix: board.statusPrefix } : {}),
    },
  }
}
