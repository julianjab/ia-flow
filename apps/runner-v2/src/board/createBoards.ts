import type { GithubClient } from '@ia-flow/github-api'
import type { ProjectConfig } from '../config/RunnerConfig.js'
import { BoardReader } from '../inbox/BoardReader.js'
import type { Board } from './Board.js'
import { Boards } from './Boards.js'
import { IssuesBoard } from './IssuesBoard.js'
import { ProjectsV2Board } from './ProjectsV2Board.js'

/** El board de cada proyecto, con la identidad del runner. */
export function createBoards(projects: ProjectConfig[], github: GithubClient): Boards {
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
        })
      : new ProjectsV2Board(project.id, project.board, github, reader),
  )
  return new Boards(boards)
}
