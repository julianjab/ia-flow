import type { VariableDefinition } from '@ia-flow/shared'
import type { ResolveContext } from './types.js'

export const definitions: VariableDefinition[] = [
  {
    key: 'project.name',
    group: 'project',
    syntax: '{{...}}',
    description: 'Nombre del proyecto.',
  },
  {
    key: 'project.language',
    group: 'project',
    syntax: '{{...}}',
    description: 'Idioma configurado (e.g. "español").',
  },
  {
    key: 'project.field_options.FIELD',
    group: 'project',
    syntax: '{{...}}',
    description:
      'Opciones del campo FIELD del proyecto GitHub (reemplaza FIELD con el nombre del campo).',
    example: '{{project.field_options.priority}}',
  },

  // ─── Phase-prompt variables ({...} syntax) ───────────────────────────────────
  {
    key: 'checkbox_answers',
    group: 'project',
    syntax: '{...}',
    description: 'Bloque pre-formateado con las respuestas de checkboxes del issue.',
    phases: ['refine-functional', 'refine-technical'],
  },
  {
    key: 'comments',
    group: 'project',
    syntax: '{...}',
    description: 'Bloque pre-formateado con los comentarios del equipo.',
    phases: ['refine-functional', 'refine-technical'],
  },
  {
    key: 'contexts',
    group: 'project',
    syntax: '{...}',
    description: 'Secciones pre-renderizadas de contexto por repo (CLAUDE.md, manifests, árbol).',
    phases: ['refine-functional', 'refine-technical'],
  },
  {
    key: 'response_language',
    group: 'project',
    syntax: '{...}',
    description: 'Idioma en el que el modelo debe responder.',
    phases: ['refine-functional', 'refine-technical'],
  },
]

export function resolve(
  key: string,
  subpath: string | undefined,
  ctx: ResolveContext,
): string | undefined {
  if (!ctx.project) return ''
  const fullKey = subpath ? `${key}.${subpath}` : key
  return ctx.project[fullKey] ?? ''
}
