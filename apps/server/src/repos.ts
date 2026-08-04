import { readdir, readFile, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import type { RepoEntry, RepoMappingEntry } from '@ia-flow/shared'
import { loadProviderConfig } from './providers/index.js'

const HOME = Bun.env.HOME ?? '/Users/julianbuitrago'
const DEVELOPMENT_ROOT = join(HOME, 'development')
const LAHAUS_ROOT = join(DEVELOPMENT_ROOT, 'lahaus')

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

export interface ResolvedGithubRepo {
  owner: string
  repo: string
  path?: string   // Local path when known (from mapping or auto-discovery)
  workflow?: 'worktree' | 'branch' | 'main'  // Per-repo staging strategy; TODO wire into implement providers
}

// Resolution order:
//   1. Explicit mapping in providers.json → repoMappings[localName]
//   2. Auto-discovery under ~/development (or explicit path override)
//   3. Fallback: { owner: defaultOwner, repo: localName }
// TODO(open-question): cache ProviderConfig in-memory (invalidated by saveProviderConfig)
// if disk reads become a hot path.
export async function resolveGithubRepo(
  localName: string,
  defaultOwner: string,
): Promise<ResolvedGithubRepo> {
  const config = await loadProviderConfig()
  const entry = config.repoMappings?.[localName]

  // 1. Explicit mapping
  if (typeof entry === 'string') {
    return { owner: defaultOwner, repo: entry }
  }
  if (entry && typeof entry === 'object') {
    const explicitPath = entry.path
    const owner = entry.githubOwner ?? defaultOwner
    let repo = entry.githubRepo

    // If path is provided but repo is not, discover repo from the local git remote
    if (!repo && explicitPath) {
      const discovered = await discoverFromPath(explicitPath)
      if (discovered) return { owner: discovered.owner, repo: discovered.repo, path: explicitPath, workflow: entry.workflow }
    }

    if (repo) return { owner, repo, path: explicitPath, workflow: entry.workflow }
  }

  // 2. Auto-discovery under ~/development
  const discovered = await discoverFromDevelopment(localName)
  if (discovered) return discovered

  // 3. Fallback
  return { owner: defaultOwner, repo: localName }
}

// Backward-compatible helper — returns only the repo name.
export async function resolveGithubRepoName(
  localName: string,
  defaultOwner = '',
): Promise<string> {
  const { repo } = await resolveGithubRepo(localName, defaultOwner)
  return repo
}

// ─── GitHub remote discovery ─────────────────────────────────────────────

// Parses `origin` remote URL from a git config file.
// Supports both HTTPS (https://github.com/owner/repo(.git)?) and SSH (git@github.com:owner/repo(.git)?) forms.
export function parseGithubRemote(gitConfig: string): { owner: string; repo: string } | null {
  const originMatch = gitConfig.match(/\[remote\s+"origin"\][^[]*?url\s*=\s*(\S+)/)
  if (!originMatch) return null
  const url = originMatch[1]
  const https = url.match(/github\.com[:/]([^/]+)\/([^/\s]+?)(?:\.git)?$/)
  if (!https) return null
  return { owner: https[1], repo: https[2] }
}

async function discoverFromPath(repoPath: string): Promise<ResolvedGithubRepo | null> {
  const gitConfigPath = join(repoPath, '.git', 'config')
  if (!existsSync(gitConfigPath)) return null
  try {
    const cfg = await readFile(gitConfigPath, 'utf-8')
    const parsed = parseGithubRemote(cfg)
    if (!parsed) return null
    return { owner: parsed.owner, repo: parsed.repo, path: repoPath }
  } catch {
    return null
  }
}

// Walks ~/development up to a limited depth looking for a directory named `localName`
// whose .git/config points to github.com.
async function discoverFromDevelopment(localName: string): Promise<ResolvedGithubRepo | null> {
  if (!existsSync(DEVELOPMENT_ROOT)) return null
  return walkForRepo(DEVELOPMENT_ROOT, localName, 3)
}

async function walkForRepo(
  dir: string,
  targetName: string,
  depthRemaining: number,
): Promise<ResolvedGithubRepo | null> {
  if (depthRemaining < 0) return null
  let entries: Awaited<ReturnType<typeof readdir>>
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.name === targetName) {
      const found = await discoverFromPath(full)
      if (found) return found
    }
  }
  // Recurse only if not found at this level
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    if (entry.name === targetName) continue
    const full = join(dir, entry.name)
    try {
      const st = await stat(full)
      if (!st.isDirectory()) continue
    } catch {
      continue
    }
    const nested = await walkForRepo(full, targetName, depthRemaining - 1)
    if (nested) return nested
  }
  return null
}

export type { RepoMappingEntry }
