import { existsSync } from 'fs'
import type { Dirent } from 'fs'
import { join } from 'path'
import type { RepoEntry, RepoMappingEntry, RepoWorkflow } from '@ia-flow/shared'
import { readFile, readdir, stat } from 'fs/promises'

type DirentString = Dirent<string>
import { getDbRepo, getScanRoots } from './db.js'

export const HOME = Bun.env.HOME ?? '/Users/julianbuitrago'

type RepoType = RepoEntry['type']

let cachedRepos: RepoEntry[] | null = null

async function scanDir(dir: string, type: RepoType, into: RepoEntry[]): Promise<void> {
  if (!existsSync(dir)) return
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue
      if (into.some((r) => r.name === entry.name)) continue
      const repoPath = join(dir, entry.name)
      into.push({
        name: entry.name,
        path: repoPath,
        type,
        hasGit: existsSync(join(repoPath, '.git')),
      })
    }
  } catch {
    // Directory not accessible, skip
  }
}

export async function listRepos(): Promise<RepoEntry[]> {
  if (cachedRepos) return cachedRepos

  const repos: RepoEntry[] = []

  // User-defined scan roots (flat one-level scan, type='unknown')
  for (const root of getScanRoots()) {
    const expanded = root.startsWith('~/') ? join(HOME, root.slice(2)) : root
    await scanDir(expanded, 'unknown', repos)
  }

  cachedRepos = repos
  return repos
}

export async function getRepoPaths(repoNames: string[]): Promise<RepoEntry[]> {
  const all = await listRepos()

  return repoNames.flatMap((name) => {
    const discovered = all.find((r) => r.name === name)
    if (discovered) {
      const mapping = getDbRepo(name)
      return [{ ...discovered, workflow: mapping?.workflow }]
    }

    // Fallback: explicit path in DB repo mapping
    const mapping = getDbRepo(name)
    if (mapping?.path) {
      const expandedPath = mapping.path.startsWith('~/')
        ? join(HOME, mapping.path.slice(2))
        : mapping.path
      if (existsSync(expandedPath)) {
        return [
          {
            name,
            path: expandedPath,
            type: 'unknown' as const,
            hasGit: existsSync(join(expandedPath, '.git')),
            workflow: mapping.workflow,
          },
        ]
      }
    }

    return []
  })
}

// Returns the configured workflow for a repo, defaulting to 'branch'.
export function getRepoWorkflow(repoName: string): RepoWorkflow {
  return getDbRepo(repoName)?.workflow ?? 'branch'
}

export function clearRepoCache() {
  cachedRepos = null
}

export interface ResolvedGithubRepo {
  owner: string
  repo: string
  path?: string // Local path when known (from mapping or auto-discovery)
  workflow?: 'worktree' | 'branch' | 'main' // Per-repo staging strategy; TODO wire into implement providers
}

// Resolution order:
//   1. Explicit mapping in DB → repos table
//   2. Auto-discovery under ~/development (or explicit path override)
//   3. Fallback: { owner: defaultOwner, repo: localName }
export async function resolveGithubRepo(
  localName: string,
  defaultOwner: string,
): Promise<ResolvedGithubRepo> {
  const entry = getDbRepo(localName)

  // 1. Explicit mapping from DB
  if (entry) {
    const explicitPath = entry.path
    const owner = entry.githubOwner ?? defaultOwner
    const repo = entry.githubRepo

    if (!repo && explicitPath) {
      const discovered = await discoverFromPath(explicitPath)
      if (discovered)
        return {
          owner: discovered.owner,
          repo: discovered.repo,
          path: explicitPath,
          workflow: entry.workflow,
        }
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
export async function resolveGithubRepoName(localName: string, defaultOwner = ''): Promise<string> {
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
  const developmentRoot = join(HOME, 'development')
  if (!existsSync(developmentRoot)) return null
  return walkForRepo(developmentRoot, localName, 3)
}

async function walkForRepo(
  dir: string,
  targetName: string,
  depthRemaining: number,
): Promise<ResolvedGithubRepo | null> {
  if (depthRemaining < 0) return null
  let entries: DirentString[]
  try {
    entries = (await readdir(dir, { withFileTypes: true, encoding: 'utf8' })) as DirentString[]
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
