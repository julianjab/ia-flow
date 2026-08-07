import type { StepType } from './types.js'

export type TemplateSyntax = '{{...}}' | '{...}'
export type TemplateScope = 'agent' | 'phase'

export interface TemplateVariable {
  key: string
  scope: TemplateScope
  syntax: TemplateSyntax
  description: string
  example?: string
  group?: string
  phases?: StepType[]
}

export const TEMPLATE_VARIABLES: TemplateVariable[] = [
  // ─── Agent scope ({{...}}) ────────────────────────────────────────────────
  { key: 'daemon_url',                       scope: 'agent', syntax: '{{...}}', group: 'system',    description: 'ia-flow daemon base URL (e.g. http://localhost:3001).' },
  { key: 'context.repos',                    scope: 'agent', syntax: '{{...}}', group: 'context',   description: 'CLAUDE.md content + file tree for each selected repo.' },
  { key: 'variables.KEY',                    scope: 'agent', syntax: '{{...}}', group: 'variables', description: 'Reemplaza KEY con una variable definida en el agente.' },
  { key: 'project.name',                     scope: 'agent', syntax: '{{...}}', group: 'project',   description: 'Nombre del proyecto.' },
  { key: 'project.language',                 scope: 'agent', syntax: '{{...}}', group: 'project',   description: 'Idioma configurado (e.g. "español").' },
  { key: 'project.field_options.priority',   scope: 'agent', syntax: '{{...}}', group: 'project',   description: 'Opciones del campo Priority.' },
  { key: 'project.field_options.size',       scope: 'agent', syntax: '{{...}}', group: 'project',   description: 'Opciones del campo Size.' },
  { key: 'project.field_options.task_type',  scope: 'agent', syntax: '{{...}}', group: 'project',   description: 'Opciones del campo Task Type.' },
  { key: 'project.field_options.field_name', scope: 'agent', syntax: '{{...}}', group: 'project',   description: 'Reemplaza field_name con el nombre de cualquier campo del proyecto.' },
  { key: 'task.title',                       scope: 'agent', syntax: '{{...}}', group: 'task',      description: 'Título del issue.' },
  { key: 'task.description',                 scope: 'agent', syntax: '{{...}}', group: 'task',      description: 'Cuerpo completo del issue.' },
  { key: 'task.type',                        scope: 'agent', syntax: '{{...}}', group: 'task',      description: '"functional" | "technical".' },
  { key: 'task.status',                      scope: 'agent', syntax: '{{...}}', group: 'task',      description: 'Status actual de la tarea en el pipeline.' },
  { key: 'task.repos',                       scope: 'agent', syntax: '{{...}}', group: 'task',      description: 'Repos seleccionados, separados por coma.' },
  { key: 'task.issueUrl',                    scope: 'agent', syntax: '{{...}}', group: 'task',      description: 'URL completa del issue de GitHub.' },
  { key: 'task.issueNumber',                 scope: 'agent', syntax: '{{...}}', group: 'task',      description: 'Número del issue.' },
  { key: 'task.id',                          scope: 'agent', syntax: '{{...}}', group: 'task',      description: 'ID interno de la tarea (para llamadas a complete_task / fail_task).' },
  { key: 'task.sections.NAME',               scope: 'agent', syntax: '{{...}}', group: 'task',      description: 'Sección nombrada del output de un agente previo en el pipeline.' },

  // ─── Phase scope ({...}) — refine-functional / refine-technical ───────────
  { key: 'task_title',        scope: 'phase', syntax: '{...}', phases: ['refine-functional', 'refine-technical'], description: 'Título del issue.' },
  { key: 'task_description',  scope: 'phase', syntax: '{...}', phases: ['refine-functional', 'refine-technical'], description: 'Descripción / cuerpo del issue.' },
  { key: 'task_type',         scope: 'phase', syntax: '{...}', phases: ['refine-functional', 'refine-technical'], description: '"functional" | "technical".' },
  { key: 'repos',             scope: 'phase', syntax: '{...}', phases: ['refine-functional', 'refine-technical'], description: 'Repos seleccionados, separados por coma.' },
  { key: 'checkbox_answers',  scope: 'phase', syntax: '{...}', phases: ['refine-functional', 'refine-technical'], description: 'Bloque pre-formateado con las respuestas de checkboxes del issue.' },
  { key: 'comments',          scope: 'phase', syntax: '{...}', phases: ['refine-functional', 'refine-technical'], description: 'Bloque pre-formateado con los comentarios del equipo.' },
  { key: 'contexts',          scope: 'phase', syntax: '{...}', phases: ['refine-functional', 'refine-technical'], description: 'Secciones pre-renderizadas de contexto por repo (CLAUDE.md, manifests, árbol).' },
  { key: 'response_language', scope: 'phase', syntax: '{...}', phases: ['refine-functional', 'refine-technical'], description: 'Idioma en el que el modelo debe responder.' },

  // ─── Phase scope ({...}) — implement ──────────────────────────────────────
  { key: 'issue_url',   scope: 'phase', syntax: '{...}', phases: ['implement'], description: 'URL completa del issue de GitHub.' },
  { key: 'repo',        scope: 'phase', syntax: '{...}', phases: ['implement'], description: 'Nombre del repo destino.' },
  { key: 'git_context', scope: 'phase', syntax: '{...}', phases: ['implement'], description: 'Contexto de git (branch / worktree / setup ya aplicado).' },
]

export function formatVariable(v: TemplateVariable): string {
  return v.syntax === '{{...}}' ? `{{${v.key}}}` : `{${v.key}}`
}

export function getAgentVariables(): TemplateVariable[] {
  return TEMPLATE_VARIABLES.filter(v => v.scope === 'agent')
}

export function getPhaseVariables(step: StepType): TemplateVariable[] {
  return TEMPLATE_VARIABLES.filter(v => v.scope === 'phase' && v.phases?.includes(step))
}

/** Whitelist for the runtime resolver. */
export const KNOWN_AGENT_VARIABLE_PATHS: ReadonlySet<string> = new Set(
  getAgentVariables().map(v => v.key),
)
