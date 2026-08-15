import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RepoDef, Task } from '@ia-flow/shared'
import { resolve } from '../project.js'
import type { ResolveContext } from '../types.js'

function baseTask(): Task {
  return {
    id: 't1',
    title: 'x',
    description: 'y',
    type: 'functional',
    repos: [],
    status: 'Queued',
    created_at: '2026-01-01T00:00:00Z',
  } as unknown as Task
}

function ctx(
  projectRepos: RepoDef[] | undefined,
  project?: Record<string, string>,
): ResolveContext {
  return { task: baseTask(), projectRepos, project }
}

describe('project.repos.*', () => {
  const repos: RepoDef[] = [
    { name: 'backend', projectId: 'p1', description: 'API en FastAPI', workflow: 'worktree' },
    { name: 'web', projectId: 'p1', path: '/tmp/web' },
    { name: 'infra', projectId: 'p1', githubOwner: 'lahaus', githubRepo: 'infra' },
  ]

  it('formats {{project.repos}} as markdown list with description fallback to path or name', () => {
    expect(resolve('repos', undefined, ctx(repos))).toBe(
      '- backend — API en FastAPI\n- web — /tmp/web\n- infra',
    )
  })

  it('returns empty string when no repos', () => {
    expect(resolve('repos', undefined, ctx([]))).toBe('')
    expect(resolve('repos', undefined, ctx(undefined))).toBe('')
  })

  it('{{project.repos.names}} joins names with comma', () => {
    expect(resolve('repos', 'names', ctx(repos))).toBe('backend, web, infra')
  })

  it('{{project.repos.NAME}} returns description or empty', () => {
    expect(resolve('repos', 'backend', ctx(repos))).toBe('API en FastAPI')
    expect(resolve('repos', 'web', ctx(repos))).toBe('')
    expect(resolve('repos', 'nope', ctx(repos))).toBe('')
  })

  it('{{project.repos.NAME.path}} returns path or empty', () => {
    expect(resolve('repos', 'web.path', ctx(repos))).toBe('/tmp/web')
    expect(resolve('repos', 'backend.path', ctx(repos))).toBe('')
  })

  it('{{project.repos.NAME.github}} formats owner/repo, empty if partial', () => {
    expect(resolve('repos', 'infra.github', ctx(repos))).toBe('lahaus/infra')
    expect(resolve('repos', 'backend.github', ctx(repos))).toBe('')
  })

  it('{{project.repos.NAME.workflow}} returns workflow or empty', () => {
    expect(resolve('repos', 'backend.workflow', ctx(repos))).toBe('worktree')
    expect(resolve('repos', 'web.workflow', ctx(repos))).toBe('')
  })

  it('{{project.repos.NAME.context}} returns multiline "key: value" block with only present fields', () => {
    const full: RepoDef[] = [
      {
        name: 'api',
        projectId: 'p1',
        description: 'API',
        path: '/tmp/api',
        githubOwner: 'lahaus',
        githubRepo: 'api',
        workflow: 'branch',
      },
    ]
    expect(resolve('repos', 'api.context', ctx(full))).toBe(
      'name: api\npath_local: /tmp/api\ngithub: lahaus/api\nworkflow: branch\ndescription: API',
    )
    expect(resolve('repos', 'web.context', ctx(repos))).toBe('name: web\npath_local: /tmp/web')
  })

  it('unknown subfield returns empty', () => {
    expect(resolve('repos', 'infra.unknown', ctx(repos))).toBe('')
  })
})

describe('project.repos.NAME.tree', () => {
  let root: string
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'ia-flow-tree-'))
    mkdirSync(join(root, 'src', 'deep'), { recursive: true })
    mkdirSync(join(root, 'node_modules', 'foo'), { recursive: true })
    mkdirSync(join(root, '.git'), { recursive: true })
    writeFileSync(join(root, 'package.json'), '{}')
    writeFileSync(join(root, 'src', 'index.ts'), '')
    writeFileSync(join(root, 'src', 'deep', 'inner.ts'), '')
    writeFileSync(join(root, 'node_modules', 'foo', 'index.js'), '')
  })
  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('renders tree with default depth 2, ignoring node_modules and .git', () => {
    const repos: RepoDef[] = [{ name: 'r', projectId: 'p1', path: root }]
    const out = resolve('repos', 'r.tree', ctx(repos))!
    expect(out).toContain('├── src/')
    expect(out).toContain('│   ├── deep/')
    expect(out).toContain('│   └── index.ts')
    expect(out).toContain('└── package.json')
    expect(out).not.toContain('node_modules')
    expect(out).not.toContain('.git')
    // depth 2 → we see "deep/" but not its inner file
    expect(out).not.toContain('inner.ts')
  })

  it('accepts explicit depth via {{...tree.N}}', () => {
    const repos: RepoDef[] = [{ name: 'r', projectId: 'p1', path: root }]
    const out = resolve('repos', 'r.tree.3', ctx(repos))!
    expect(out).toContain('inner.ts')
  })

  it('returns empty if repo has no path', () => {
    const repos: RepoDef[] = [{ name: 'r', projectId: 'p1' }]
    expect(resolve('repos', 'r.tree', ctx(repos))).toBe('')
  })
})

describe('project.name/language/fields.* (unchanged)', () => {
  it('returns project map value when present', () => {
    const c = ctx(undefined, { name: 'IA Flow', 'fields.priority': 'high, low' })
    expect(resolve('name', undefined, c)).toBe('IA Flow')
    expect(resolve('fields', 'priority', c)).toBe('high, low')
  })

  it('returns empty when project missing', () => {
    expect(resolve('name', undefined, ctx(undefined))).toBe('')
  })
})
