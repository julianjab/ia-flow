import type { GithubClient } from '@ia-flow/github-api'
import { createLogger } from '@ia-flow/telemetry'
import type { ProjectConfig } from '../config/RunnerConfig.js'
import { BoardReader } from '../inbox/BoardReader.js'
import type { Board } from './Board.js'
import { Boards } from './Boards.js'
import { IssuesBoard } from './IssuesBoard.js'
import { ProjectsV2Board } from './ProjectsV2Board.js'

const log = createLogger('ia-flow-runner-v2.board')

/** El board de cada proyecto, con la identidad del runner. */
export function createBoards(
  projects: ProjectConfig[],
  github: GithubClient,
  /** `inbox.labels.blocked`: cómo se llama el label de "trabada". */
  blockedLabel?: string,
): Boards {
  // Un solo lector para todos: su cache es por board y el webhook de uno suelta el de todos.
  const reader = new BoardReader(github)
  const boards: Board[] = projects.map((project) =>
    project.boardKind === 'issues'
      ? new IssuesBoard(project.id, github, {
          repos: project.repos.map((repo) => ({
            owner: repo.githubOwner as string,
            repo: repo.githubRepo as string,
          })),
          ...project.issuesBoard,
          ...(blockedLabel ? { blockedLabel } : {}),
          ...(project.stacking ? { stackingLabel: project.stacking.label } : {}),
          // Lo que el runner escribe además de la columna: el tipo y la marca "en curso".
          fields: ['Task Type', ...(project.workingMarker ? [project.workingMarker.field] : [])],
        })
      : new ProjectsV2Board(project.id, project.board, github, reader, project.stacking?.label),
  )
  // Una relectura en segundo plano que falla deja la bandeja con lo que tenía: sólo se anota.
  return new Boards(boards, {
    onError: (error) =>
      log.warn(`relectura del board: ${error instanceof Error ? error.message : String(error)}`),
  })
}
