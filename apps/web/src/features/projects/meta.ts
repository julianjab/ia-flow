import { formatGithubRepoUrl } from '@/composables/parseGithubRepoRef'
import { type ProjectsMeta, fetchProjectsMeta } from '@/features/projects/api'
import type { SourceRef } from '@ia-flow/shared'

// Choices for the project forms (source kinds, daemon modes), resolved by the
// server from what it actually has wired. The constants below are only a
// fallback for when that call fails — no picker should hardcode this list,
// which is how 'github-issues' stayed invisible in the UI while the server
// built it fine.
export const FALLBACK_META: ProjectsMeta = {
  sourceKinds: ['github-projects', 'local', 'github-issues'],
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
// `kind`; 'github' y 'github-hybrid' son alias deprecados ('github-projects'
// con owner+repo en la config reemplaza al segundo, ver
// createDefaultSourceFactory), así que siguen mapeados acá para que una fila
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
 * Dónde vive el proyecto en el proveedor, para linkearlo. 'github-projects'
 * (y sus alias viejos 'github'/'github-hybrid') guarda owner/repo cuando
 * además vigila un repo — ahí linkeamos al repo/issues, no al board: el set
 * de items rastreados lo define el repo, no el board (ver GithubHybridSource).
 * Sin owner/repo cae a la URL literal del board. 'github-issues' arma la
 * suya con owner/repo — y esta traducción ya estaba duplicada en la vista de
 * detalle y en la pestaña Overview, con el mismo bug en las dos: leían
 * `config.url`, que 'github-issues' nunca tuvo, así que esos proyectos
 * quedaban sin link.
 */
export function projectSourceUrl(source: SourceRef | null | undefined): string | null {
  if (!source) return null
  const owner = typeof source.config?.owner === 'string' ? source.config.owner : undefined
  const repo = typeof source.config?.repo === 'string' ? source.config.repo : undefined
  if (
    source.kind === 'github-projects' ||
    source.kind === 'github' ||
    source.kind === 'github-hybrid'
  ) {
    if (owner && repo) {
      const repoUrl = formatGithubRepoUrl({ owner, repo })
      if (repoUrl) return `${repoUrl}/issues`
    }
    const url = source.config?.url
    return typeof url === 'string' && url ? url : null
  }
  if (source.kind === 'github-issues') {
    const repoUrl = formatGithubRepoUrl({ owner, repo })
    return repoUrl ? `${repoUrl}/issues` : null
  }
  return null
}
