import { existsSync } from 'fs'
import { join } from 'path'
import type { RepoContext, RepoEntry } from '@ia-flow/shared'
import { readFile, readdir } from 'fs/promises'

const MANIFEST_FILES = ['package.json', 'go.mod', 'pyproject.toml', 'Gemfile']
const MAX_TREE_DEPTH = 3

async function buildTree(dir: string, depth: number, prefix = ''): Promise<string> {
  if (depth === 0) return ''

  let entries: Awaited<ReturnType<typeof readdir>>
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return ''
  }

  const filtered = entries
    .filter(
      (e) =>
        !e.name.startsWith('.') &&
        e.name !== 'node_modules' &&
        e.name !== 'vendor' &&
        e.name !== '__pycache__' &&
        e.name !== 'dist' &&
        e.name !== '.git',
    )
    .slice(0, 30) // cap at 30 entries per level

  let tree = ''
  for (let i = 0; i < filtered.length; i++) {
    const entry = filtered[i]
    const isLast = i === filtered.length - 1
    const connector = isLast ? '└── ' : '├── '
    const childPrefix = isLast ? '    ' : '│   '

    tree += `${prefix}${connector}${entry.name}\n`
    if (entry.isDirectory() && depth > 1) {
      tree += await buildTree(join(dir, entry.name), depth - 1, prefix + childPrefix)
    }
  }

  return tree
}

export async function gatherRepoContext(repo: RepoEntry): Promise<RepoContext> {
  const ctx: RepoContext = {
    name: repo.name,
    path: repo.path,
    type: repo.type,
    workflow: repo.workflow,
  }

  // Read CLAUDE.md if present
  const claudeMdPath = join(repo.path, 'CLAUDE.md')
  if (existsSync(claudeMdPath)) {
    try {
      ctx.claude_md = await readFile(claudeMdPath, 'utf-8')
    } catch {
      // ignore
    }
  }

  // Read manifest file
  for (const manifest of MANIFEST_FILES) {
    const manifestPath = join(repo.path, manifest)
    if (existsSync(manifestPath)) {
      try {
        ctx.manifest = await readFile(manifestPath, 'utf-8')
        break
      } catch {
        // ignore
      }
    }
  }

  // Build directory tree
  try {
    ctx.directory_tree = `${repo.name}/\n` + (await buildTree(repo.path, MAX_TREE_DEPTH))
  } catch {
    ctx.directory_tree = repo.name
  }

  return ctx
}

export async function gatherContextsForRepos(repos: RepoEntry[]): Promise<RepoContext[]> {
  return Promise.all(repos.map(gatherRepoContext))
}
