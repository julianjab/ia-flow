import type { AssistantScope } from '@ia-flow/shared'

// De qué habla una conversación, en palabras y en lo que se escribe para elegirlo:
// `#owner/repo#n` una tarea, `@proyecto` un proyecto, `@general` todo el runner.

/** La clave de un contexto (la misma que usa el runner para agrupar conversaciones). */
export function scopeKey(scope: AssistantScope): string {
  if (scope.kind === 'general') return 'general'
  return scope.kind === 'project' ? `project:${scope.project_id}` : `task:${scope.ref}`
}

/** Cómo se lee: `#1640 subscriptions`, `@lahaus-ai-flow`, `General`. */
export function scopeLabel(scope: AssistantScope): string {
  if (scope.kind === 'general') return 'General'
  if (scope.kind === 'project') return scope.project_id
  const [repo, number] = scope.ref.split('#')
  return `#${number} ${repo?.split('/')[1] ?? repo}`
}

/** Una frase para el encabezado: «sobre la-haus/subscriptions#1640». */
export function scopeSentence(scope: AssistantScope): string {
  if (scope.kind === 'general') return 'sobre todo el runner'
  return scope.kind === 'project' ? `sobre el proyecto ${scope.project_id}` : `sobre ${scope.ref}`
}

const REF_RE = /^[^/\s#]+\/[^/\s#]+#\d+$/

/** Lo que se está escribiendo al final de la caja para elegir contexto: `#…` o `@…`. */
export function scopeQuery(text: string): { sigil: '#' | '@'; query: string } | null {
  const m = /(^|\s)([#@])([\w\-./#]*)$/.exec(text)
  if (!m) return null
  return { sigil: m[2] as '#' | '@', query: (m[3] ?? '').toLowerCase() }
}

/** La caja sin el `#…`/`@…` del final, una vez elegido el contexto. */
export function dropScopeQuery(text: string): string {
  return text.replace(/(^|\s)[#@][\w\-./#]*$/, '$1').trimStart()
}

/** Una ref escrita entera (`owner/repo#n`), aunque no esté en la bandeja. */
export function typedRef(query: string): string | null {
  return REF_RE.test(query) ? query : null
}
