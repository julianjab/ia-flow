import type { StepType } from './types.js'

// ─── Groups & Contexts ────────────────────────────────────────────────────────

/** Domain of data a variable belongs to. */
export type VariableGroup = 'system' | 'github' | 'project' | 'task' | 'context' | 'custom'

/** Where a template is rendered, determining which variable groups are accessible. */
export type TemplateContext = 'system-prompt' | 'agent-prompt' | 'phase-prompt'

/** Authoritative access matrix: which groups each context may use. */
export const CONTEXT_ACCESS: Record<TemplateContext, VariableGroup[]> = {
  'system-prompt': ['system'],
  'agent-prompt': ['system', 'github', 'project', 'task', 'context', 'custom'],
  'phase-prompt': ['task', 'project'],
}

// ─── Variable Definition ──────────────────────────────────────────────────────

export interface VariableSubfield {
  description: string
  example?: string
}

export interface VariableDefinition {
  key: string
  group: VariableGroup
  syntax: '{{...}}' | '{...}'
  description: string
  example?: string
  /** Sub-paths accessible via {{key.subfield}} */
  subfields?: Record<string, VariableSubfield>
  /** Restricts this variable to specific phase steps (phase-prompt context only). */
  phases?: StepType[]
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

// ─── Backward-compat aliases ──────────────────────────────────────────────────

/** @deprecated Use VariableDefinition */
export type TemplateVariable = VariableDefinition
/** @deprecated Use VariableGroup */
export type TemplateSyntax = '{{...}}' | '{...}'
/** @deprecated Use TemplateContext */
export type TemplateScope = 'agent' | 'phase'

export function formatVariable(v: VariableDefinition): string {
  return v.syntax === '{{...}}' ? `{{${v.key}}}` : `{${v.key}}`
}

/**
 * @deprecated The variable registry has moved to apps/server/src/variables/.
 * Fetch variable definitions at runtime via GET /api/variables?context=agent-prompt.
 */
export function getAgentVariables(): VariableDefinition[] {
  return []
}

/**
 * @deprecated The variable registry has moved to apps/server/src/variables/.
 * Fetch variable definitions at runtime via GET /api/variables?context=phase-prompt.
 */
export function getPhaseVariables(_step: StepType): VariableDefinition[] {
  return []
}

/** @deprecated Use CONTEXT_ACCESS to derive this. */
export const KNOWN_AGENT_VARIABLE_PATHS: ReadonlySet<string> = new Set()
