import type { GithubClient } from '@ia-flow/github-api'
import { type BoardWriter, type IssueRef, issuePath } from '@ia-flow/github-tools'
import { fieldLabel, isStatusField, type LabelScheme, labelsOfField } from './labelScheme.js'

interface RawIssue {
  labels?: Array<string | { name?: string }>
  pull_request?: unknown
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

const pathOf = (issue: IssueRef, suffix = '') =>
  issuePath(issue.owner, issue.repo, issue.number, suffix)

/**
 * Escribe los campos de la card de un issue como labels (ver `labelScheme`). Poner un valor agrega
 * su label ANTES de sacar los otros del mismo campo: en el medio la card tiene dos valores, nunca
 * ninguno. Si sacar uno falla, deshace lo que hizo: dejar dos columnas puestas se lee como la más
 * avanzada, y un movimiento hacia atrás (el reviewer devuelve a Build) quedaría en la vieja. Si el
 * valor no es una columna declarada, tira antes de tocar nada, como un Project v2 con una opción
 * que no existe.
 */
export class IssueLabelFields implements BoardWriter {
  constructor(
    private readonly client: GithubClient,
    private readonly scheme: LabelScheme,
  ) {}

  /** Los labels del issue, y si en realidad es un PR (la API de issues también los devuelve). */
  async read(issue: IssueRef): Promise<{ labels: string[]; isPullRequest: boolean }> {
    const raw = await this.client.requestJson<RawIssue>(pathOf(issue))
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

    if (add.length > 0) await this.addLabels(issue, add)
    const removed: string[] = []
    for (const label of new Set(remove)) {
      const res = await this.deleteLabel(issue, label)
      // 404: ya no lo tenía — el estado final es el pedido.
      if (res.ok || res.status === 404) {
        removed.push(label)
        continue
      }
      const undone = await this.undo(issue, add, removed)
      throw new Error(
        `update_issue: no se pudo sacar "${label}" → ${res.status}` +
          (undone
            ? ' (cambio deshecho)'
            : ` (no se pudo deshacer: la card puede tener ${[...add, label].join(' y ')} a la vez)`),
      )
    }
  }

  /** Un 5xx suele ser transitorio: se reintenta una vez antes de deshacer, porque deshacer también
   *  pasa por webhooks (el label que se vuelve a poner despierta a la pipeline de su columna). */
  private async deleteLabel(issue: IssueRef, label: string): Promise<Response> {
    const path = pathOf(issue, `/labels/${encodeURIComponent(label)}`)
    const res = await this.client.request(path, { method: 'DELETE' })
    return res.status >= 500 ? this.client.request(path, { method: 'DELETE' }) : res
  }

  private async addLabels(issue: IssueRef, labels: string[]): Promise<void> {
    await this.client.requestJson(pathOf(issue, '/labels'), {
      method: 'POST',
      body: JSON.stringify({ labels }),
    })
  }

  /** Vuelve la card a como estaba: saca lo que agregó y devuelve lo que ya había sacado. */
  private async undo(issue: IssueRef, added: string[], removed: string[]): Promise<boolean> {
    try {
      if (removed.length > 0) await this.addLabels(issue, removed)
      for (const label of added) {
        const res = await this.client.request(
          pathOf(issue, `/labels/${encodeURIComponent(label)}`),
          { method: 'DELETE' },
        )
        // `request` no tira ante un 5xx: sin mirar la respuesta, un rollback fallido pasaría por hecho.
        if (!res.ok && res.status !== 404) return false
      }
      return true
    } catch {
      return false
    }
  }
}
