import { type Rule, RuleSchema } from '@ia-flow/shared'
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
