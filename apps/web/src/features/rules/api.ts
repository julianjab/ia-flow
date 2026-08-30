import {
  type NamedAction,
  NamedActionSchema,
  type Pipeline,
  PipelineSchema,
  type Rule,
  RuleSchema,
} from '@ia-flow/shared'
import axios from 'axios'

// CRUD de reglas. El ámbito viaja por query igual que en agents-crud:
//   ?scope=global    → reglas globales (project_id IS NULL)
//   ?projectId=<id>  → las de ese proyecto
// Nunca se deduce del body, para que una escritura no pueda promover en
// silencio una regla global a una de proyecto.

export type RuleScope = { kind: 'global' } | { kind: 'project'; projectId: string }

export function scopeQuery(scope: RuleScope): string {
  return scope.kind === 'global'
    ? 'scope=global'
    : `projectId=${encodeURIComponent(scope.projectId)}`
}

export interface RuleListResult {
  rules: Rule[]
  readOnly: boolean
}

export async function fetchRules(scope: RuleScope): Promise<RuleListResult> {
  const { data } = await axios.get<{ rules: unknown[]; readOnly: boolean }>(
    `/api/rules?${scopeQuery(scope)}`,
  )
  return { rules: data.rules.map((r) => RuleSchema.parse(r)), readOnly: data.readOnly }
}

/** Los tipos de acción que ESTE daemon sabe ejecutar. El editor sólo ofrece
 *  éstos: guardar una regla con una acción que el daemon no tiene la haría
 *  fallar recién en el primer evento, en silencio. */
export async function fetchActionKinds(): Promise<string[]> {
  const { data } = await axios.get<{ kinds: string[] }>('/api/rules/action-kinds')
  return data.kinds
}

export async function createRule(scope: RuleScope, rule: Rule): Promise<Rule> {
  const { data } = await axios.post<{ rule: unknown }>(`/api/rules?${scopeQuery(scope)}`, rule)
  return RuleSchema.parse(data.rule)
}

export async function updateRule(scope: RuleScope, rule: Rule): Promise<Rule> {
  const { data } = await axios.put<{ rule: unknown }>(
    `/api/rules/${encodeURIComponent(rule.id)}?${scopeQuery(scope)}`,
    rule,
  )
  return RuleSchema.parse(data.rule)
}

export async function deleteRule(scope: RuleScope, id: string): Promise<void> {
  await axios.delete(`/api/rules/${encodeURIComponent(id)}?${scopeQuery(scope)}`)
}

export async function reorderRules(scope: RuleScope, ids: string[]): Promise<void> {
  await axios.put(`/api/rules/reorder?${scopeQuery(scope)}`, { ids })
}

/**
 * El pipeline del ámbito: lo configurado MÁS lo que corre encima.
 *
 * Es un request y no tres porque son una sola pregunta. Correlacionar reglas,
 * runs y esperas del lado del cliente daría un momento donde un run aparece
 * colgado de una regla que la lista todavía no traía.
 *
 * El ámbito global no manda `projectId` — eso trae sólo las reglas globales,
 * que es exactamente lo que ese ámbito significa, y no "todos los proyectos".
 */
export async function fetchPipeline(scope: RuleScope): Promise<Pipeline> {
  const q = scope.kind === 'project' ? `?projectId=${encodeURIComponent(scope.projectId)}` : ''
  const { data } = await axios.get<unknown>(`/api/pipeline${q}`)
  return PipelineSchema.parse(data)
}

// ─── Acciones con nombre ───────────────────────────────────────────────────
//
// Viven en esta feature y no en una propia porque son la contracara del `do[]`
// de una regla: se crean desde el Pipeline, se referencian desde una regla, y
// separarlas obligaría a importar entre features — que el repo prohíbe.

export interface ActionListResult {
  actions: NamedAction[]
  readOnly: boolean
}

export async function fetchActions(scope: RuleScope): Promise<ActionListResult> {
  const { data } = await axios.get<{ actions: unknown[]; readOnly: boolean }>(
    `/api/actions?${scopeQuery(scope)}`,
  )
  return { actions: data.actions.map((a) => NamedActionSchema.parse(a)), readOnly: data.readOnly }
}

export async function createAction(scope: RuleScope, action: NamedAction): Promise<NamedAction> {
  const { data } = await axios.post<{ action: unknown }>(
    `/api/actions?${scopeQuery(scope)}`,
    action,
  )
  return NamedActionSchema.parse(data.action)
}

export async function updateAction(scope: RuleScope, action: NamedAction): Promise<NamedAction> {
  const { data } = await axios.put<{ action: unknown }>(
    `/api/actions/${encodeURIComponent(action.id)}?${scopeQuery(scope)}`,
    action,
  )
  return NamedActionSchema.parse(data.action)
}

/** El 409 con `usedBy` NO se traga: es la lista de reglas que se romperían, y
 *  es exactamente lo que quien borra necesita ver antes de decidir. */
export async function deleteAction(
  scope: RuleScope,
  id: string,
  opts?: { force?: boolean },
): Promise<void> {
  const force = opts?.force ? '&force=1' : ''
  await axios.delete(`/api/actions/${encodeURIComponent(id)}?${scopeQuery(scope)}${force}`)
}
