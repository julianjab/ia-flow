import type { GithubClient } from '@ia-flow/github-api'
import type { BoardWriter, IssueRef } from '@ia-flow/github-tools'
import {
  fieldLabel,
  fieldPrefix,
  isStatusField,
  type LabelScheme,
  labelsOfField,
} from './labelScheme.js'

interface RawIssue {
  labels?: Array<string | { name?: string }>
  pull_request?: unknown
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** Los segmentos que llegan a una URL de la API: owner/repo salen de la config o de un webhook de
 *  un repo del catálogo, pero nunca se confía en que no traigan un `../`. */
function issuePath(issue: IssueRef, suffix = ''): string {
  const segment = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
  if (!segment.test(issue.owner) || !segment.test(issue.repo) || !Number.isInteger(issue.number)) {
    throw new Error(`owner/repo/número inválidos: ${issue.owner}/${issue.repo}#${issue.number}`)
  }
  return `/repos/${issue.owner}/${issue.repo}/issues/${issue.number}${suffix}`
}

/**
 * Escribe los campos de la card de un issue como labels (ver `labelScheme`). Poner un valor agrega
 * su label ANTES de sacar los otros del mismo campo: en el medio la card tiene dos valores, nunca
 * ninguno, y el estado que se lee es el más avanzado (`statusOfLabels`). Si el valor no es una
 * columna declarada tira antes de tocar nada, como un Project v2 con una opción que no existe.
 */
export class IssueLabelFields implements BoardWriter {
  constructor(
    private readonly client: GithubClient,
    private readonly scheme: LabelScheme,
  ) {}

  /** Los labels del issue, y si en realidad es un PR (la API de issues también los devuelve). */
  async read(issue: IssueRef): Promise<{ labels: string[]; isPullRequest: boolean }> {
    const raw = await this.client.requestJson<RawIssue>(issuePath(issue))
    return {
      labels: (raw.labels ?? []).map((label) =>
        typeof label === 'string' ? label : (label.name ?? ''),
      ),
      isPullRequest: raw.pull_request != null,
    }
  }

  async setFields(
    issue: IssueRef,
    set: Record<string, string>,
    clear: string[] = [],
  ): Promise<void> {
    const { statuses } = this.scheme
    for (const [field, value] of Object.entries(set)) {
      if (isStatusField(field) && statuses.length > 0 && !statuses.some((s) => same(s, value))) {
        throw new Error(
          `update_issue: "${value}" no es una opción de "Status" — opciones: ${statuses.join(', ')}`,
        )
      }
    }

    const { labels } = await this.read(issue)
    const add: string[] = []
    const remove: string[] = []
    for (const [field, value] of Object.entries(set)) {
      const target = fieldLabel(field, value, this.scheme)
      if (!labels.some((label) => same(label, target))) add.push(target)
      remove.push(
        ...labelsOfField(labels, field, this.scheme).filter((label) => !same(label, target)),
      )
    }
    for (const field of clear) remove.push(...labelsOfField(labels, field, this.scheme))

    if (add.length > 0) {
      await this.client.requestJson(issuePath(issue, '/labels'), {
        method: 'POST',
        body: JSON.stringify({ labels: add }),
      })
    }
    for (const label of new Set(remove)) {
      const res = await this.client.request(
        issuePath(issue, `/labels/${encodeURIComponent(label)}`),
        { method: 'DELETE' },
      )
      // 404: ya no lo tenía — el estado final es el pedido.
      if (!res.ok && res.status !== 404) {
        throw new Error(`update_issue: no se pudo sacar "${label}" → ${res.status}`)
      }
    }
  }

  /** Dónde viven los labels de un campo (para quien arma un evento). */
  prefixOf(field: string): string {
    return fieldPrefix(field, this.scheme)
  }
}
