import { openPullRequests } from '@ia-flow/issue-sources'
import type { PullRequestRef, Task, VariableDefinition } from '@ia-flow/shared'
import { branchNameFor } from '@ia-flow/workspace'
import { resolveRepoField } from './project.js'
import type { ResolveContext } from './types.js'

export const definitions: VariableDefinition[] = [
  {
    key: 'task.id',
    group: 'task',
    syntax: '{{...}}',
    description: 'ID interno de la tarea (para llamadas a complete_task / fail_task).',
  },
  {
    key: 'task.title',
    group: 'task',
    syntax: '{{...}}',
    description: 'Título del issue.',
  },
  {
    key: 'task.description',
    group: 'task',
    syntax: '{{...}}',
    description: 'Cuerpo completo del issue.',
  },
  {
    key: 'task.repos',
    group: 'task',
    syntax: '{{...}}',
    description: 'Repos seleccionados, separados por coma.',
  },
  {
    key: 'task.branch',
    group: 'task',
    syntax: '{{...}}',
    description:
      'Nombre canónico de la branch git para esta task (`task/<taskId>`). Usalo en prompts para referenciar la branch que el engine preparó.',
    example: '{{task.branch}}',
  },
  {
    key: 'task.issueUrl',
    group: 'task',
    syntax: '{{...}}',
    description: 'URL completa del issue de GitHub.',
  },
  {
    key: 'task.comments',
    group: 'task',
    syntax: '{{...}}',
    description: 'Comentarios del issue formateados con fecha y cuerpo, uno por bloque.',
    example: '{{task.comments}}',
  },
  {
    key: 'task.previous_outputs',
    group: 'task',
    syntax: '{{...}}',
    description:
      'La última salida estructurada (`submit_output`) de cada agente distinto que corrió sobre esta task, una por agente. Vacío si ninguno entregó salida todavía.',
    example: '{{task.previous_outputs}}',
  },
  {
    key: 'task.repo',
    group: 'task',
    syntax: '{{...}}',
    description:
      'Repo actual de la tarea (el único elemento de task.repos cuando tiene 1). Vacío si task.repos está vacío (sin refinar) o tiene múltiples (épica).',
    example: '{{task.repo}}',
    subfields: {
      name: { description: 'Nombre del repo actual.', example: '{{task.repo.name}}' },
      path: { description: 'Path local del repo actual.', example: '{{task.repo.path}}' },
      github: {
        description: 'owner/repo GitHub del repo actual.',
        example: '{{task.repo.github}}',
      },
      workflow: {
        description: 'Workflow del repo actual (worktree | branch | main).',
        example: '{{task.repo.workflow}}',
      },
      context: {
        description:
          'Contexto completo del repo actual (name/path_local/github/workflow/description).',
        example: '{{task.repo.context}}',
      },
      tree: {
        description:
          'Árbol de archivos del repo actual (default depth 2; override con {{task.repo.tree.N}}).',
        example: '{{task.repo.tree.3}}',
      },
    },
  },
  {
    key: 'task.pr',
    group: 'task',
    syntax: '{{...}}',
    description:
      'El primer PR abierto de la task. Vacío (y sus subcampos también) si no hay ninguno.',
    example: '{{task.pr.number}}',
    subfields: {
      number: { description: 'Número del PR.', example: '{{task.pr.number}}' },
      url: { description: 'URL del PR.', example: '{{task.pr.url}}' },
      files: {
        description:
          'Archivos tocados por el PR, uno por línea (`path (+adds/-dels)`). Gratis: viene en la misma consulta que number/url/ci, no agrega llamadas.',
        example: '{{task.pr.files}}',
      },
      diff: {
        description:
          'Diff unificado del PR, recortado a un tope de caracteres. LAZY: sólo se pide (un request a GitHub) si el prompt referencia esta variable — un agente que no la usa no paga el fetch.',
        example: '{{task.pr.diff}}',
      },
    },
  },
  {
    key: 'task.ci',
    group: 'task',
    syntax: '{{...}}',
    description:
      'Estado del CI del último commit del PR abierto (success/failure/error/pending/expected). Vacío si no hay PR abierto o el PR no tiene checks configurados.',
    example: '{{task.ci}}',
  },
  {
    key: 'task.labels',
    group: 'task',
    syntax: '{{...}}',
    description: 'Labels del issue, separadas por coma.',
    example: '{{task.labels}}',
  },
  {
    key: 'task.status',
    group: 'task',
    syntax: '{{...}}',
    description: 'Status actual de la task en el source (columna del board o estado del issue).',
    example: '{{task.status}}',
  },
]

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * De dónde vino el comentario, para el encabezado `[fecha · origen]`.
 *
 * No es decoración: el timeline mezcla issue y PR, y sin la marca un agente no
 * puede distinguir "cambió el alcance de la tarea" (issue) de "hay un problema
 * con este código" (PR) — que es exactamente la distinción sobre la que después
 * tiene que decidir. Para una review además va la ubicación, porque un pedido
 * sin `path:line` obliga a adivinar dónde aplica.
 */
function commentOrigin(c: Record<string, unknown>): string {
  const pr = typeof c.prNumber === 'number' ? `PR #${c.prNumber}` : 'PR'
  if (c.origin === 'pr') return pr
  if (c.origin === 'pr-review') {
    const where = typeof c.path === 'string' ? `${c.path}${c.line != null ? `:${c.line}` : ''}` : ''
    return where ? `${pr} · review · ${where}` : `${pr} · review`
  }
  // Ausente ⇒ issue: es lo que devuelven los sources que no modelan PRs.
  return 'issue'
}

function formatPreviousOutputs(
  outputs: Array<{ agentId: string; structuredOutput: Record<string, unknown> }> | undefined,
): string {
  if (!outputs || outputs.length === 0) return ''
  return outputs
    .map((o) => `[${o.agentId}]\n${JSON.stringify(o.structuredOutput, null, 2)}`)
    .join('\n\n')
}

function formatComments(comments: unknown): string {
  if (!Array.isArray(comments) || comments.length === 0) return ''
  return comments
    .map((c) => {
      const created = typeof c?.created_at === 'string' ? formatDate(c.created_at) : ''
      const body = typeof c?.body === 'string' ? c.body.trim() : ''
      if (!body) return ''
      const author = typeof c?.author === 'string' ? ` · ${c.author}` : ''
      const header = created ? `[${created} · ${commentOrigin(c)}${author}]` : ''
      return header ? `${header}\n${body}` : body
    })
    .filter(Boolean)
    .join('\n\n')
}

/** El primer PR abierto de la task — el mismo criterio de "sólo abiertos" que
 *  ya rige la lectura/escritura de comentarios y el pedido de review. */
function primaryOpenPullRequest(task: Task): PullRequestRef | undefined {
  return openPullRequests(task.pullRequests)[0]
}

function formatPrFiles(pr: PullRequestRef | undefined): string {
  if (!pr?.files?.length) return ''
  const lines = pr.files.map((f) => `${f.path} (+${f.additions}/-${f.deletions})`)
  if (pr.filesTruncated) {
    lines.push('[listado incompleto — el PR tiene más archivos de los que trae esta selección]')
  }
  return lines.join('\n')
}

function resolvePrField(subpath: string | undefined, ctx: ResolveContext): string {
  // El diff no depende del PR resuelto acá — ya llega pre-fetched (o no) por
  // `Agent.run`, gateado por `promptReferencesVariable`. Ver PrDiffPort.
  if (subpath === 'diff') return ctx.prDiff ?? ''
  const pr = primaryOpenPullRequest(ctx.task)
  if (!pr) return ''
  if (subpath === 'number') return String(pr.number)
  if (subpath === 'url') return pr.url
  if (subpath === 'files') return formatPrFiles(pr)
  return ''
}

export function resolve(
  key: string,
  subpath: string | undefined,
  ctx: ResolveContext,
): string | undefined {
  if (key === 'comments') return formatComments(ctx.task.comments)

  if (key === 'previous_outputs') return formatPreviousOutputs(ctx.previousOutputs)

  if (key === 'branch') {
    const t = ctx.task as { id?: string; branch?: string }
    if (t.branch?.trim()) return t.branch.trim()
    return t.id ? branchNameFor(t.id) : ''
  }

  if (key === 'repo') {
    const repoName = resolveCurrentRepoName(ctx)
    if (!repoName) return ''
    const repo = ctx.projectRepos?.find((r) => r.name === repoName)
    if (!repo) return ''
    if (subpath === 'name') return repo.name
    return resolveRepoField(repo, subpath)
  }

  if (key === 'pr') return resolvePrField(subpath, ctx)

  if (key === 'ci') return primaryOpenPullRequest(ctx.task)?.ci ?? ''

  const task = ctx.task as Record<string, unknown>
  const fullPath = subpath ? `${key}.${subpath}` : key
  return resolvePath(task, fullPath)
}

function resolveCurrentRepoName(ctx: ResolveContext): string | undefined {
  const t = ctx.task as { repos?: string[] }
  if (Array.isArray(t.repos) && t.repos.length === 1) return t.repos[0]
  return undefined
}

function resolvePath(obj: Record<string, unknown>, path: string): string {
  const parts = path.split('.')
  let current: unknown = obj
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return ''
    current = (current as Record<string, unknown>)[part]
  }
  if (typeof current === 'string') return current
  if (Array.isArray(current)) return current.join(', ')
  if (current != null) return String(current)
  return ''
}
