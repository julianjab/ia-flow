import { readdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import type { RepoEntry } from '@ia-flow/shared'

const HOME = Bun.env.HOME ?? '/Users/julianbuitrago'
const LAHAUS_ROOT = join(HOME, 'development', 'lahaus')

type RepoType = RepoEntry['type']

const SUBDIRS: Array<{ subdir: string; type: RepoType }> = [
  { subdir: 'backend/golang', type: 'golang' },
  { subdir: 'backend/python', type: 'python' },
  { subdir: 'backend/ruby', type: 'ruby' },
  { subdir: 'frontend', type: 'frontend' },
  { subdir: 'mobile', type: 'mobile' },
  { subdir: 'agents', type: 'agent' },
]

// Repos fuera de ~/development/lahaus — registrados manualmente vía EXTRA_REPOS env
// Formato: "nombre:ruta,nombre:ruta"
// Ejemplo: EXTRA_REPOS="ia-flow:/Users/julianjab/development/personal/ia-flow"
function loadExtraRepos(): RepoEntry[] {
  const raw = Bun.env.EXTRA_REPOS?.trim()
  if (!raw) return []

  return raw.split(',').flatMap((entry) => {
    const [name, repoPath] = entry.trim().split(':')
    if (!name || !repoPath) return []
    const expanded = repoPath.startsWith('~/')
      ? join(HOME, repoPath.slice(2))
      : repoPath
    if (!existsSync(expanded)) return []
    return [{ name: name.trim(), path: expanded, type: 'unknown' as RepoType }]
  })
}

let cachedRepos: RepoEntry[] | null = null

export async function listRepos(): Promise<RepoEntry[]> {
  if (cachedRepos) return cachedRepos

  const repos: RepoEntry[] = []

  for (const { subdir, type } of SUBDIRS) {
    const fullPath = join(LAHAUS_ROOT, subdir)
    if (!existsSync(fullPath)) continue

    try {
      const entries = await readdir(fullPath, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue
        repos.push({ name: entry.name, path: join(fullPath, entry.name), type })
      }
    } catch {
      // Directory not accessible, skip
    }
  }

  // Merge extra repos (won't duplicate if same name already exists from lahaus)
  for (const extra of loadExtraRepos()) {
    if (!repos.find((r) => r.name === extra.name)) {
      repos.push(extra)
    }
  }

  cachedRepos = repos
  return repos
}

export async function getRepoPaths(repoNames: string[]): Promise<RepoEntry[]> {
  const all = await listRepos()
  return all.filter((r) => repoNames.includes(r.name))
}

export function clearRepoCache() {
  cachedRepos = null
}
