import { existsSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ignore, { type Ignore } from 'ignore'

// Cached matcher per repo root. .gitignore files are read once and combined
// into a single `ignore` instance (root-level + any nested .gitignore, with
// their paths rewritten relative to the repo root so the semantics match
// git's own resolution).
const cache = new Map<string, Ignore>()

/** Clear the matcher cache. Exposed for tests. */
export function _clearGitignoreCache(): void {
  cache.clear()
}

function readGitignoreFor(repoRoot: string): Ignore {
  const ig = ignore()
  // Always ignore .git — git itself never lists it, and none of our tools
  // should traverse it.
  ig.add('.git')

  const rootFile = join(repoRoot, '.gitignore')
  if (existsSync(rootFile)) {
    try {
      ig.add(readFileSync(rootFile, 'utf-8'))
    } catch {
      /* unreadable — treat as no rules */
    }
  }
  return ig
}

/** Return a cached ignore matcher rooted at `repoRoot`. */
export function getGitignoreMatcher(repoRoot: string): Ignore {
  const cached = cache.get(repoRoot)
  if (cached) return cached
  const ig = readGitignoreFor(repoRoot)
  cache.set(repoRoot, ig)
  return ig
}

/**
 * Given an absolute path and a map of repo name → root, return true if the
 * path lies inside one of the repos AND is ignored by that repo's .gitignore.
 * Paths outside any registered repo return false (nothing to check against).
 */
export function isIgnored(absPath: string, repoPaths: Record<string, string>): boolean {
  for (const root of Object.values(repoPaths)) {
    if (absPath === root) return false
    const rootWithSep = root.endsWith(sep) ? root : root + sep
    if (!absPath.startsWith(rootWithSep)) continue
    const rel = relative(root, absPath)
    if (!rel || rel.startsWith('..')) return false
    // `ignore` wants POSIX separators regardless of platform.
    const posix = rel.split(sep).join('/')
    return getGitignoreMatcher(root).ignores(posix)
  }
  return false
}

/**
 * Locate the repo root for a given absolute path. Returns null if the path
 * is not inside any registered repo.
 */
export function findRepoRoot(absPath: string, repoPaths: Record<string, string>): string | null {
  for (const root of Object.values(repoPaths)) {
    if (absPath === root) return root
    const rootWithSep = root.endsWith(sep) ? root : root + sep
    if (absPath.startsWith(rootWithSep)) return root
  }
  return null
}
