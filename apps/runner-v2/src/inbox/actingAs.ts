/**
 * Los servicios del runner con la identidad de una persona: lo que una action de la bandeja hace
 * en GitHub (un comentario, un cambio de columna) queda a su nombre y con SUS permisos, no con los
 * de la App del runner. Lo que no toca GitHub —el workspace, Slack— sigue siendo del runner.
 */
import type { GithubClient } from '@ia-flow/github-api'
import type { RunnerServices } from '../actions/defineAction.js'
import type { Boards } from '../board/Boards.js'

/** `Boards` cuyo `of(id)` escribe con el cliente de la persona. Leer (`cards`, `meta`) sigue siendo
 *  del runner: la bandeja no filtra lo que una persona puede ver. */
function actingBoards(boards: Boards, client: GithubClient): Boards {
  return Object.assign(Object.create(boards) as Boards, {
    of: (projectId: string) => {
      const board = boards.of(projectId)
      const writer = board.writerFor(client)
      return Object.assign(Object.create(board), {
        setFields: writer.setFields.bind(writer),
      })
    },
  })
}

export function actingAs(services: RunnerServices, client: GithubClient): RunnerServices {
  return { ...services, github: client, boards: actingBoards(services.boards, client) }
}
