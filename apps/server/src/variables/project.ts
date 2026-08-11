import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { RepoDef, VariableDefinition } from '@ia-flow/shared'
import type { ResolveContext } from './types.js'

const TREE_DEFAULT_DEPTH = 2
const TREE_IGNORE = new Set([
  '.git',
  'node_modules',
  '.venv',
  '__pycache__',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'coverage',
  'target',
  '.idea',
  '.vscode',
  '.DS_Store',
])

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
    key: 'project.fields.FIELD',
    group: 'project',
    syntax: '{{...}}',
    description:
      'Opciones del campo FIELD del proyecto GitHub (reemplaza FIELD con el nombre del campo).',
    example: '{{project.fields.priority}}',
  },
  {
    key: 'project.repos',
    group: 'project',
    syntax: '{{...}}',
    description:
      'Repos del proyecto, como lista markdown "- name — description" (fallback al path o al nombre solo).',
    example: '{{project.repos}}',
  },
  {
    key: 'project.repos.names',
    group: 'project',
    syntax: '{{...}}',
    description: 'Nombres de los repos del proyecto, separados por coma.',
    example: '{{project.repos.names}}',
  },
  {
    key: 'project.repos.NAME',
    group: 'project',
    syntax: '{{...}}',
    description: 'Descripción del repo NAME dentro del proyecto (vacío si no tiene o no existe).',
    example: '{{project.repos.backend}}',
    subfields: {
      path: {
        description: 'Path local del repo NAME.',
        example: '{{project.repos.backend.path}}',
      },
      github: {
        description: 'owner/repo de GitHub del repo NAME (vacío si falta alguno).',
        example: '{{project.repos.backend.github}}',
      },
      workflow: {
        description:
          'Modo de trabajo del repo NAME: "worktree" | "branch" | "main" (vacío si no está configurado).',
        example: '{{project.repos.backend.workflow}}',
      },
      context: {
        description:
          'Contexto completo del repo NAME en formato "clave: valor" por línea (name, path_local, github, workflow, description). Omite claves sin valor.',
        example: '{{project.repos.backend.context}}',
      },
      tree: {
        description: `Árbol de archivos del repo NAME. Si es repo git usa git ls-files (respeta .gitignore); si no, fs walk con ignore list fija. Profundidad por defecto ${TREE_DEFAULT_DEPTH}; override con {{project.repos.NAME.tree.N}}. Vacío si el repo no tiene path.`,
        example: '{{project.repos.backend.tree.3}}',
      },
    },
  },
]

function formatRepoList(repos: RepoDef[]): string {
  if (repos.length === 0) return ''
  return repos
    .map((r) => {
      const label = r.description?.trim() || r.path?.trim() || null
      return label ? `- ${r.name} — ${label}` : `- ${r.name}`
    })
    .join('\n')
}

function findRepo(repos: RepoDef[] | undefined, name: string): RepoDef | undefined {
  return repos?.find((r) => r.name === name)
}

/** Resolves a `field` (path | github | workflow | context | tree[.N] | '' for description) against a RepoDef. */
export function resolveRepoField(repo: RepoDef, field: string | undefined): string {
  if (!field) return repo.description ?? ''
  if (field === 'path') return repo.path ?? ''
  if (field === 'github') {
    return repo.githubOwner && repo.githubRepo ? `${repo.githubOwner}/${repo.githubRepo}` : ''
  }
  if (field === 'workflow') return repo.workflow ?? ''
  if (field === 'context') return formatRepoContext(repo)
  if (field === 'tree' || field.startsWith('tree.')) {
    if (!repo.path?.trim()) return ''
    const rest = field === 'tree' ? '' : field.slice('tree.'.length)
    const parsed = rest ? Number.parseInt(rest, 10) : TREE_DEFAULT_DEPTH
    const depth = Number.isFinite(parsed) && parsed > 0 ? parsed : TREE_DEFAULT_DEPTH
    return formatRepoTree(repo.path, depth)
  }
  return ''
}

function formatRepoTree(root: string, maxDepth: number): string {
  const fromGit = formatRepoTreeFromGit(root, maxDepth)
  if (fromGit != null) return fromGit
  const lines: string[] = []
  const walk = (dir: string, depth: number, prefix: string) => {
    if (depth > maxDepth) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    const visible = entries
      .filter((e) => !TREE_IGNORE.has(e.name) && !e.name.startsWith('.git'))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
        return a.name.localeCompare(b.name)
      })
    for (let i = 0; i < visible.length; i++) {
      const entry = visible[i]
      const last = i === visible.length - 1
      const branch = last ? '└── ' : '├── '
      const name = entry.isDirectory() ? `${entry.name}/` : entry.name
      lines.push(`${prefix}${branch}${name}`)
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), depth + 1, prefix + (last ? '    ' : '│   '))
      }
    }
  }
  walk(root, 1, '')
  return lines.join('\n')
}

type TreeNode = { name: string; isDir: boolean; children: Map<string, TreeNode> }

function formatRepoTreeFromGit(root: string, maxDepth: number): string | null {
  const result = spawnSync(
    'git',
    ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard'],
    { encoding: 'utf8' },
  )
  if (result.status !== 0 || typeof result.stdout !== 'string') return null

  const paths = result.stdout.split('\n').filter(Boolean)
  const rootNode: TreeNode = { name: '', isDir: true, children: new Map() }

  for (const rel of paths) {
    const parts = rel.split('/')
    let node = rootNode
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      const isDir = i < parts.length - 1
      let child = node.children.get(part)
      if (!child) {
        child = { name: part, isDir, children: new Map() }
        node.children.set(part, child)
      }
      node = child
    }
  }

  const lines: string[] = []
  const render = (node: TreeNode, depth: number, prefix: string) => {
    if (depth > maxDepth) return
    const entries = [...node.children.values()].sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      const last = i === entries.length - 1
      const branch = last ? '└── ' : '├── '
      const name = entry.isDir ? `${entry.name}/` : entry.name
      lines.push(`${prefix}${branch}${name}`)
      if (entry.isDir) {
        render(entry, depth + 1, prefix + (last ? '    ' : '│   '))
      }
    }
  }
  render(rootNode, 1, '')
  return lines.join('\n')
}

function formatRepoContext(repo: RepoDef): string {
  const lines: string[] = [`name: ${repo.name}`]
  if (repo.path?.trim()) lines.push(`path_local: ${repo.path}`)
  if (repo.githubOwner && repo.githubRepo) {
    lines.push(`github: ${repo.githubOwner}/${repo.githubRepo}`)
  }
  if (repo.workflow) lines.push(`workflow: ${repo.workflow}`)
  if (repo.description?.trim()) lines.push(`description: ${repo.description}`)
  return lines.join('\n')
}

export function resolve(
  key: string,
  subpath: string | undefined,
  ctx: ResolveContext,
): string | undefined {
  if (key === 'repos') {
    const repos = ctx.projectRepos ?? []
    if (!subpath) return formatRepoList(repos)
    if (subpath === 'names') return repos.map((r) => r.name).join(', ')

    // subpath is either "NAME" or "NAME.field"
    const dot = subpath.indexOf('.')
    const repoName = dot === -1 ? subpath : subpath.slice(0, dot)
    const field = dot === -1 ? undefined : subpath.slice(dot + 1)
    const repo = findRepo(repos, repoName)
    if (!repo) return ''
    return resolveRepoField(repo, field)
  }

  if (!ctx.project) return ''
  const fullKey = subpath ? `${key}.${subpath}` : key
  return ctx.project[fullKey] ?? ''
}
