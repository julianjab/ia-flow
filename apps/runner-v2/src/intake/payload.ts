/**
 * El payload del evento de una task, con la forma que esperan las pipelines y los prompts de
 * claw-agents: `item.*` (lo que filtran los `when`), `task.*` y `event.payload.*` (las variables de
 * los prompts y briefs), más los campos propios de cada tipo de evento.
 */

export interface EventArgs {
  eventType: string
  owner: string
  repo: string
  number: number
  status?: string
  type: string
  labels: string[]
  comment?: string
  author: string
  commentId: number
  pr?: number
  /** Campos propios del evento (`from`/`to`, `state`, `conclusion`, …). */
  extra?: Record<string, unknown>
  /** Lo que se mezcla en `task.*` además de lo que sale del issue (`comments`, `ci`, `pr`). */
  taskExtra?: Record<string, unknown>
  /** Lo que se mezcla en `item.*` (lo que filtran las reglas): p. ej. `blocked`. */
  itemExtra?: Record<string, unknown>
}

export interface IssueData {
  title: string
  body: string
  url: string
  labels: string[]
}

/** El payload de `args` sobre un issue ya leído. */
export function assemblePayload(
  args: EventArgs,
  issue: IssueData,
  project: {
    /** `{{project.repos}}` de los prompts: el catálogo de repos del proyecto, en texto. */
    repos: string
    /** La rama de la task. */
    branch: string
  },
): Record<string, unknown> {
  const labels = args.labels.length > 0 ? args.labels : issue.labels
  const payload: Record<string, unknown> = {
    // Qué evento es: lo que miran los `when` de los pasos de una pipeline que escucha varios.
    eventType: args.eventType,
    owner: args.owner,
    repo: args.repo,
    number: args.number,
    issueNumber: args.number,
    repos: [args.repo],
    task_type: args.type,
    item: { status: args.status, type: args.type, repos: [args.repo], labels, ...args.itemExtra },
    project: { repos: project.repos },
    task: {
      id: `${args.owner}/${args.repo}#${args.number}`,
      title: issue.title,
      description: issue.body,
      issueUrl: issue.url,
      repos: args.repo,
      repo: { name: args.repo },
      branch: project.branch,
      comments: '',
      ...(args.pr
        ? {
            pr: {
              number: args.pr,
              url: `https://github.com/${args.owner}/${args.repo}/pull/${args.pr}`,
            },
          }
        : {}),
      ...args.taskExtra,
    },
  }
  if (args.comment !== undefined) {
    Object.assign(payload, {
      action: 'created',
      body: args.comment,
      author: args.author,
      commentId: args.commentId,
    })
  }
  if (args.pr) Object.assign(payload, { pr: { number: args.pr }, prNumber: args.pr })
  if (args.extra) Object.assign(payload, args.extra)

  // `{{event.payload.x}}` en los briefs: el payload se ve a sí mismo bajo `event.payload`.
  return { ...payload, event: { payload: { ...payload } } }
}
