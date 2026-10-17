/**
 * A qué board entra el issue de una mejora al abrirlo, y en qué columnas puede: el de un proyecto
 * de este runner si el repo es suyo (la card se suma con `BoardMoves`), o el que lleva otro runner
 * por labels (`inbox.issueBoards`: la columna es un label del issue). Un repo que no es de ninguno
 * se abre sin columna.
 */

/** El board de un repo y sus columnas, en el orden en que se ofrecen. */
export type IssueBoard =
  | { kind: 'project'; project_id: string; columns: string[] }
  | { kind: 'labels'; columns: string[]; labels: Record<string, string> }

export interface IssueBoardSources {
  projects: Array<{ projectId: string; repos?: string[] }>
  /** Las columnas del board de un proyecto (las lee el board, con su cache). */
  statuses: (projectId: string) => Promise<string[]>
  /** `inbox.issueBoards`: repo → { columna: label }. */
  labelBoards: Record<string, Record<string, string>>
}

export function issueBoards(sources: IssueBoardSources) {
  return async (repo: string): Promise<IssueBoard | undefined> => {
    const project = sources.projects.find((spec) => spec.repos?.includes(repo))
    if (project) {
      const columns = await sources.statuses(project.projectId).catch(() => [])
      return { kind: 'project', project_id: project.projectId, columns }
    }
    const labels = sources.labelBoards[repo]
    if (labels && Object.keys(labels).length) {
      return { kind: 'labels', columns: Object.keys(labels), labels }
    }
    return undefined
  }
}

/** La columna elegida, validada contra las del board: sin elegir, la de entrada (la del board del
 *  proyecto la decide `BoardMoves`; la de labels es la primera). */
export function placement(
  board: IssueBoard,
  status: string | undefined,
): { status?: string; label?: string } {
  if (status && board.columns.length && !board.columns.includes(status)) {
    throw new Error(`"${status}" no es una columna: ${board.columns.join(', ')}`)
  }
  if (board.kind === 'project') return status ? { status } : {}
  const column = status ?? board.columns[0]
  return column ? { status: column, label: board.labels[column] } : {}
}
