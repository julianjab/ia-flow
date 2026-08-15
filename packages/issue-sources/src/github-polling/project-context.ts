import type { ProjectMeta } from './api/project.js'

/**
 * Builds a flat key→value map from ProjectMeta for use in {{project.*}} prompt variables.
 *
 * Single-select fields expose their options as:
 *   "fields.priority"  → "Low, Medium, High"
 *   "fields.size"      → "XS, S, M, L, XL"
 *   "fields.task_type" → "Functional, Technical, Bug"
 *
 * Spaces in field names are normalized to underscores and lowercased.
 */
function normalizeFieldName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '_')
}

export function buildProjectContext(meta: ProjectMeta): Record<string, string> {
  const ctx: Record<string, string> = {}
  for (const [fieldName, field] of Object.entries(meta.fields)) {
    if (field.options?.length) {
      ctx[`fields.${normalizeFieldName(fieldName)}`] = field.options.map((o) => o.name).join(', ')
    }
  }
  return ctx
}
