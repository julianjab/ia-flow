import { type ProjectsMeta, fetchProjectsMeta } from '@/features/projects/api'

// Choices for the project forms (source kinds, daemon modes), resolved by the
// server from what it actually has wired. The constants below are only a
// fallback for when that call fails — no picker should hardcode this list,
// which is how 'github-issues' stayed invisible in the UI while the server
// built it fine.
export const FALLBACK_META: ProjectsMeta = {
  sourceKinds: ['github', 'local', 'github-issues'],
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
