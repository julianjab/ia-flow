/**
 * De un webhook crudo de GitHub a DÓNDE está su task y qué evento le toca — puro, sin leer nada.
 * Lo que no alcanza con el payload (qué issue hay detrás de un item del board, qué issue
 * implementa el PR de un comentario) queda como algo a leer; lo resuelve `ResolveTaskAction`.
 *
 *   projects_v2_item     created → issue.created · Status → issue.status_changed (from/to) ·
 *                        otro campo → projects_v2_item.edited
 *   issue_comment        el issue, o el que implementa el PR si se comentó en un PR
 *   pull_request(_review) el issue que el PR cierra según GitHub (hay que leerlo); sin él, se salta
 *   check_suite, workflow_run   la task del PR de la corrida (hay que leerlo); sólo `completed`
 *
 * La relación issue ↔ PR la lleva GitHub (sección "Development", `Closes #n`): acá no se deduce
 * del nombre de una rama. Un PR sin issue vinculado no es una task: su número no resuelve como
 * `Issue` en GraphQL, así que usarlo como número de task rompía el despacho con `Could not
 * resolve to an Issue`.
 *
 * Los filtros baratos van acá, antes de cualquier lectura: una acción que ninguna pipeline
 * escucha, un item que no es un issue, un CI que no terminó.
 */
import { parseGithubCheckPayload } from './GithubCheckPayload.js'
import { parseGithubIssueCommentPayload } from './GithubIssuePayload.js'
import { parseGithubProjectItemPayload } from './GithubProjectItemPayload.js'
import {
  parseGithubPullRequestPayload,
  parseGithubPullRequestReviewPayload,
} from './GithubPullRequestPayload.js'

type Raw = Record<string, unknown>

/** Lo propio de cada evento que llega al agente, además de la task. */
export interface EventFields {
  emit: string
  /** Pisa el status del board: el `to` de un cambio que el board todavía no refleja. */
  status?: string
  extra: Record<string, unknown>
  comment?: { body: string; author: string; id: number }
}

export type Location =
  | { skip: string }
  /** Un item del board: el issue sale de leerlo. */
  | ({ item: string } & EventFields)
  /** Un issue de `owner/repo`: `number`, o el que implementa el PR `inspect` (hay que leerlo). */
  | ({ owner: string; repo: string; number?: number; pr?: number; inspect?: number } & EventFields)

export function locate(type: string, raw: Raw): Location {
  switch (type) {
    case 'projects_v2_item':
      return boardItem(raw)
    case 'issue_comment':
      return comment(raw)
    case 'pull_request':
    case 'pull_request_review':
      return pullRequest(type, raw)
    case 'check_suite':
    case 'workflow_run':
      return ciRun(type, raw)
    default:
      return { skip: `${type} no es un webhook que el intake entienda` }
  }
}

function boardItem(raw: Raw): Location {
  const item = parseGithubProjectItemPayload(raw)
  if (item.contentType !== 'Issue') return { skip: `el item envuelve un ${item.contentType}` }
  if (raw.action === 'created') return { item: item.itemId, emit: 'issue.created', extra: {} }
  if (raw.action !== 'edited') return { skip: `projects_v2_item.${raw.action}` }
  if (item.fieldName.toLowerCase() !== 'status') {
    return {
      item: item.itemId,
      emit: 'projects_v2_item.edited',
      extra: { action: raw.action, fieldName: item.fieldName },
    }
  }
  if (item.from !== undefined && item.from === item.to) {
    return { skip: `Status sin cambio (${item.to})` }
  }
  // Quién movió la card: el engine no deja que el eco de un cambio del propio runner (su App)
  // interrumpa al agente que corre (`engine.interrupt.ownSenders` en runner.yaml).
  const sender = (raw.sender as { login?: unknown } | undefined)?.login
  return {
    item: item.itemId,
    emit: 'issue.status_changed',
    // Sin `to` (GitHub no siempre lo manda), el status que quedó en el board.
    ...(item.to !== undefined ? { status: item.to } : {}),
    extra: { from: item.from, to: item.to, ...(typeof sender === 'string' ? { sender } : {}) },
  }
}

function comment(raw: Raw): Location {
  if (raw.action !== 'created') return { skip: `issue_comment.${raw.action}` }
  const parsed = parseGithubIssueCommentPayload(raw)
  const fields: EventFields = {
    emit: 'issue_comment',
    extra: { action: raw.action },
    comment: { body: parsed.commentBody, author: parsed.sender, id: parsed.commentId },
  }
  const { owner, repo, number } = parsed
  // En un PR: la task es el issue que implementa, que sólo dice el PR (su rama o su body).
  if (parsed.isPullRequest) return { owner, repo, pr: number, inspect: number, ...fields }
  return { owner, repo, number, ...fields }
}

function pullRequest(type: string, raw: Raw): Location {
  const review =
    type === 'pull_request_review' ? parseGithubPullRequestReviewPayload(raw) : undefined
  const pr = review ?? parseGithubPullRequestPayload(raw)
  return {
    owner: pr.owner,
    repo: pr.repo,
    pr: pr.number,
    inspect: pr.number,
    emit: type,
    extra: {
      action: raw.action,
      pr: {
        number: pr.number,
        title: pr.title,
        state: pr.state,
        isDraft: pr.isDraft,
        merged: pr.merged,
        author: pr.author,
        head: { ref: pr.headRef, sha: pr.headSha },
        base: { ref: pr.baseRef },
        url: pr.url,
      },
      ...(review
        ? { state: review.reviewState, reviewer: review.reviewer, body: review.reviewBody }
        : {}),
    },
  }
}

function ciRun(type: 'check_suite' | 'workflow_run', raw: Raw): Location {
  // El CI manda decenas de deliveries por push; las pipelines sólo escuchan `completed`.
  if (raw.action !== 'completed') return { skip: `${type}.${raw.action}` }
  const run = parseGithubCheckPayload(type, raw)
  const prNumber = run.prNumbers[0]
  // Sin PR no hay a qué issue apuntar: la relación la dice GitHub, no la rama.
  if (prNumber === undefined) return { skip: `corrida sin PR (${run.branch})` }
  return {
    owner: run.owner,
    repo: run.repo,
    pr: prNumber,
    inspect: prNumber,
    emit: type,
    extra: {
      action: raw.action,
      conclusion: run.conclusion,
      status: run.status,
      name: run.name,
      branch: run.branch,
      sha: run.sha,
      url: run.url,
      prNumber,
      kind: type,
    },
  }
}

/** El PR mergeado de un webhook — el issue que cierra (el prerrequisito) lo dice GitHub. */
export function mergedPullRequest(
  raw: Raw,
): { skip: string } | { owner: string; repo: string; pr: number } {
  const pr = parseGithubPullRequestPayload(raw)
  if (!pr.merged) return { skip: `PR #${pr.number} cerrado sin mergear` }
  return { owner: pr.owner, repo: pr.repo, pr: pr.number }
}
