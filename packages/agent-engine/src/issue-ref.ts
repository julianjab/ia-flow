import type { IssueItem } from '@ia-flow/issue-sources'

/**
 * Referencia humana de un item para los logs: `owner/repo#123`.
 *
 * `item.id` es el id nativo de la fuente (`PVTI_lADOAy2Wus4Bhj…` en un GitHub
 * Project) — estable y correcto para el engine, pero ilegible para el operador
 * que lee el log y quiere abrir el issue. Los dos sources de GitHub ya publican
 * `owner`/`repoName`/`issueNumber` en `meta`, así que la ref sale sin ninguna
 * llamada extra. Sin esos campos (local-fs, o un item a medio construir) cae al
 * id, que siempre existe.
 */
export function issueRef(item: Pick<IssueItem, 'id' | 'meta'>): string {
  const meta = item.meta ?? {}
  const number = meta.issueNumber
  if (typeof number !== 'number' && typeof number !== 'string') return item.id
  const repo = typeof meta.repoName === 'string' ? meta.repoName : ''
  const owner = typeof meta.owner === 'string' ? meta.owner : ''
  const slug = owner && repo ? `${owner}/${repo}` : repo || owner
  return slug ? `${slug}#${number}` : `#${number}`
}
