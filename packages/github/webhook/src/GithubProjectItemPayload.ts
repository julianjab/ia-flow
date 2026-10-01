// `type`, no `interface` — ver la nota en CLAUDE.md sobre por qué (asignabilidad a
// `GithubWebhookEvent['payload']`, que resuelve a `Record<string, unknown>` por default).
export type GithubProjectItemPayload = {
  /** Node id (GraphQL) del `ProjectV2Item` — NO el del issue: son nodos distintos. */
  itemId: string
  /** Node id del Project v2 al que pertenece el item. */
  projectNodeId: string
  /** Node id de lo que el item envuelve (el issue/PR/draft). */
  contentNodeId: string
  /** `Issue` | `PullRequest` | `DraftIssue`. */
  contentType: string
  /** Qué campo cambió (`Status`, `Task Type`, …) — vacío en acciones que no editan un campo. */
  fieldName: string
  /** `single_select` | `labels` | `text` | … */
  fieldType: string
  /**
   * Los valores viejo/nuevo del campo, cuando GitHub los manda — sólo para algunos tipos de campo
   * (single-select sí; `labels`, no). `undefined` = GitHub no lo dijo, NO "estaba vacío": para
   * saber el valor hay que leer el item por GraphQL.
   */
  from?: string
  to?: string
  sender: string
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '')
}

/** Un valor de `changes.field_value.from|to`: un string, o un objeto con `name` (single-select). */
function fieldValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  const name = (value as Record<string, unknown> | null | undefined)?.name
  return typeof name === 'string' ? name : undefined
}

/**
 * Extrae los campos de un payload de webhook `projects_v2_item` (ya parseado). El payload no trae
 * `repository`: un item de Projects puede venir de cualquier repo, así que ubicar el issue
 * (`owner/repo#n`) a partir de `contentNodeId`/`itemId` es trabajo de la app (una query GraphQL).
 */
export function parseGithubProjectItemPayload(
  raw: Record<string, unknown>,
): GithubProjectItemPayload {
  const item = raw.projects_v2_item as Record<string, unknown>
  const changes = raw.changes as Record<string, unknown> | undefined
  const field = changes?.field_value as Record<string, unknown> | undefined
  const from = fieldValue(field?.from)
  const to = fieldValue(field?.to)
  return {
    itemId: str(item.node_id),
    projectNodeId: str(item.project_node_id),
    contentNodeId: str(item.content_node_id),
    contentType: str(item.content_type),
    fieldName: str(field?.field_name),
    fieldType: str(field?.field_type),
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    sender: str((raw.sender as Record<string, unknown> | undefined)?.login),
  }
}
