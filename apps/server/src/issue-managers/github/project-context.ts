import type { ProjectMeta } from '../../github/project.js'

/**
 * Builds a flat key→value map from ProjectMeta for use in {{project.*}} prompt variables.
 *
 * Single-select fields expose their options as:
 *   "field_options.Priority"  → "Low, Medium, High"
 *   "field_options.Size"      → "XS, S, M, L, XL"
 *   "field_options.Task Type" → "Functional, Technical, Bug"
 *
 * Spaces in field names are preserved; the variable resolver does a direct key lookup
 * so {{project.field_options.Task Type}} works as-is.
 */
function normalizeFieldName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '_')
}

export function buildProjectContext(meta: ProjectMeta): Record<string, string> {
  const ctx: Record<string, string> = {}
  for (const [fieldName, field] of Object.entries(meta.fields)) {
    if (field.options?.length) {
      ctx[`field_options.${normalizeFieldName(fieldName)}`] = field.options
        .map((o) => o.name)
        .join(', ')
    }
  }
  return ctx
}
