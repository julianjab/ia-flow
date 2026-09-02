import { formatGithubRepoUrl } from '@/composables/parseGithubRepoRef'
import { type ProjectsMeta, fetchProjectsMeta } from '@/features/projects/api'
import type { SourceRef } from '@ia-flow/shared'

// Choices for the project forms (source kinds, daemon modes), resolved by the
// server from what it actually has wired. The constants below are only a
// fallback for when that call fails — no picker should hardcode this list,
// which is how 'github-issues' stayed invisible in the UI while the server
// built it fine.
export const FALLBACK_META: ProjectsMeta = {
  sourceKinds: ['github-projects', 'local', 'github-issues', 'github-hybrid'],
  daemonModes: ['webhook', 'polling'],
  daemonModeFallback: 'webhook',
}

// One request per page load, shared by every form that needs it.
let pending: Promise<ProjectsMeta> | null = null

export function loadProjectsMeta(): Promise<ProjectsMeta> {
  if (!pending) {
    pending = fetchProjectsMeta()
      .then((meta) => ({ ...FALLBACK_META, ...meta }))
      .catch(() => FALLBACK_META)
  }
  return pending
}

// Test seam: drops the cached promise so each test starts from a clean fetch.
export function resetProjectsMetaCache(): void {
  pending = null
}

// Cómo se nombra cada fuente en pantalla. El id que viaja y se persiste es el
// `kind`; 'github' es el alias deprecado de 'github-projects' (ver
// createDefaultSourceFactory), así que sigue mapeado acá para que una fila
// vieja no muestre el id crudo mientras no se migre.
const KIND_LABELS: Record<string, string> = {
  'github-projects': 'GitHub Projects',
  github: 'GitHub Projects',
  'github-issues': 'GitHub Repo',
  'github-hybrid': 'GitHub Repo + Project',
  local: 'Local',
}

export function sourceKindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind
}

/**
 * Dónde vive el proyecto en el proveedor, para linkearlo. Cada fuente lo
 * guarda distinto — 'github-projects' (y su alias viejo 'github') tiene la
 * URL literal del board,
 * 'github-issues' la arma con owner/repo — y esta traducción ya estaba
 * duplicada en la vista de detalle y en la pestaña Overview, con el mismo
 * bug en las dos: leían `config.url`, que 'github-issues' nunca tuvo, así
 * que esos proyectos quedaban sin link.
 */
export function projectSourceUrl(source: SourceRef | null | undefined): string | null {
  if (!source) return null
  if (source.kind === 'github-projects' || source.kind === 'github') {
    const url = source.config?.url
    return typeof url === 'string' && url ? url : null
  }
  if (source.kind === 'github-issues' || source.kind === 'github-hybrid') {
    // github-hybrid también guarda `config.url` (el board) — linkeamos al
    // repo/issues igual que github-issues, porque el set de items rastreados
    // lo define el repo, no el board (ver GithubHybridSource).
    const repoUrl = formatGithubRepoUrl({
      owner: typeof source.config?.owner === 'string' ? source.config.owner : undefined,
      repo: typeof source.config?.repo === 'string' ? source.config.repo : undefined,
    })
    // Directo a los issues: son los items que esta fuente maneja.
    return repoUrl ? `${repoUrl}/issues` : null
  }
  return null
}
