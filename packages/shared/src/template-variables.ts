// ─── Groups & Contexts ────────────────────────────────────────────────────────

/** Domain of data a variable belongs to. */
export type VariableGroup = 'system' | 'project' | 'task' | 'custom'

/** Where a template is rendered, determining which variable groups are accessible. */
export type TemplateContext = 'system-prompt' | 'agent-prompt' | 'phase-prompt'

/** Authoritative access matrix: which groups each context may use. */
export const CONTEXT_ACCESS: Record<TemplateContext, VariableGroup[]> = {
  'system-prompt': ['system'],
  'agent-prompt': ['system', 'project', 'task', 'custom'],
  /** @deprecated Legacy phase-prompts. Kept only so the route/UI don't crash — no variables offered. */
  'phase-prompt': [],
}

// ─── Variable Definition ──────────────────────────────────────────────────────

export interface VariableSubfield {
  description: string
  example?: string
}

export interface VariableDefinition {
  key: string
  group: VariableGroup
  syntax: '{{...}}'
  description: string
  example?: string
  /** Sub-paths accessible via {{key.subfield}} */
  subfields?: Record<string, VariableSubfield>
}

// ─── Agent variable value ─────────────────────────────────────────────────────

/** A custom agent variable can be a plain string or a rich object with a full-detail variant. */
export type AgentVariableValue =
  | string
  | {
      value: string
      /** {{variables.KEY.full}} — complete/detailed rendition of the variable. */
      full?: string
      /** Shown in the agent editor UI to explain the variable's purpose. */
      description?: string
    }

export function formatVariable(v: VariableDefinition): string {
  return `{{${v.key}}}`
}
