import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveGithubRepo, resolveGithubRepoName, parseGithubRemote } from './repos.js'
import {
  saveProviderConfig,
  loadProviderConfig,
  DEFAULT_ANTHROPIC_SETTINGS,
} from './providers/index.js'
import { getProviderConfigFromDb, setProviderConfigToDb, deleteProviderConfigFromDb } from './db.js'
import { ProviderConfigSchema, type ProviderConfig, type RepoMapping } from '@ia-flow/shared'

let originalDbConfig: Record<string, unknown> | null = null

function baseConfig(repoMappings: RepoMapping = {}): ProviderConfig {
  return {
    steps: {
      'refine-functional': 'anthropic-api',
      'refine-technical': 'anthropic-api',
      implement: 'tmux-claude',
    },
    anthropicApi: DEFAULT_ANTHROPIC_SETTINGS,
    repoMappings,
  }
}

beforeAll(() => {
  originalDbConfig = getProviderConfigFromDb()
})

afterAll(() => {
  if (originalDbConfig !== null) setProviderConfigToDb(originalDbConfig)
  else deleteProviderConfigFromDb()
})

beforeEach(() => {
  deleteProviderConfigFromDb()
})

describe('resolveGithubRepo (with explicit mapping)', () => {
  it('shorthand string mapping overrides only the repo name', async () => {
    await saveProviderConfig(baseConfig({ 'ia-flow': 'julian-ia-flow' }))
    const result = await resolveGithubRepo('ia-flow', 'la-haus')
    expect(result).toEqual({ owner: 'la-haus', repo: 'julian-ia-flow' })
  })

  it('object mapping overrides owner + repo + path + workflow', async () => {
    await saveProviderConfig(
      baseConfig({
        'ia-flow': {
          githubOwner: 'julianjab',
          githubRepo: 'julian-ia-flow',
          path: '/some/local/path',
          workflow: 'worktree',
        },
      }),
    )
    const result = await resolveGithubRepo('ia-flow', 'la-haus')
    expect(result).toEqual({
      owner: 'julianjab',
      repo: 'julian-ia-flow',
      path: '/some/local/path',
      workflow: 'worktree',
    })
  })

  it('accepts each workflow value: worktree, branch, main', async () => {
    for (const workflow of ['worktree', 'branch', 'main'] as const) {
      await saveProviderConfig(
        baseConfig({ foo: { githubRepo: 'foo', workflow } }),
      )
      const result = await resolveGithubRepo('foo', 'la-haus')
      expect(result.workflow).toBe(workflow)
    }
  })

  it('falls back to defaultOwner + local name when no mapping and no dev-folder match', async () => {
    await saveProviderConfig(baseConfig({}))
    const result = await resolveGithubRepo('nonexistent-repo-xyz-9876', 'la-haus')
    expect(result).toEqual({ owner: 'la-haus', repo: 'nonexistent-repo-xyz-9876' })
  })
})

describe('resolveGithubRepoName (backward-compat helper)', () => {
  it('returns mapped GitHub name when mapping exists', async () => {
    await saveProviderConfig(baseConfig({ 'ia-flow': 'julian-ia-flow' }))
    expect(await resolveGithubRepoName('ia-flow', 'la-haus')).toBe('julian-ia-flow')
  })

  it('falls back to local name unchanged when no mapping', async () => {
    await saveProviderConfig(baseConfig({}))
    expect(await resolveGithubRepoName('subscriptions', 'la-haus')).toBe('subscriptions')
  })
})

describe('parseGithubRemote', () => {
  it('parses HTTPS remote', () => {
    const cfg = '[remote "origin"]\n\turl = https://github.com/la-haus/julian-ia-flow.git\n\tfetch = ...\n'
    expect(parseGithubRemote(cfg)).toEqual({ owner: 'la-haus', repo: 'julian-ia-flow' })
  })

  it('parses SSH remote', () => {
    const cfg = '[remote "origin"]\n\turl = git@github.com:julianjab/julian-ia-flow.git\n'
    expect(parseGithubRemote(cfg)).toEqual({ owner: 'julianjab', repo: 'julian-ia-flow' })
  })

  it('parses HTTPS remote without .git suffix', () => {
    const cfg = '[remote "origin"]\n\turl = https://github.com/foo/bar\n'
    expect(parseGithubRemote(cfg)).toEqual({ owner: 'foo', repo: 'bar' })
  })

  it('returns null when there is no origin remote', () => {
    expect(parseGithubRemote('[core]\n\trepositoryformatversion = 0\n')).toBeNull()
  })
})

describe('resolveGithubRepo with explicit path (auto-discovery from remote)', () => {
  let tmpRepo: string

  beforeEach(async () => {
    tmpRepo = join(tmpdir(), `ia-flow-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(join(tmpRepo, '.git'), { recursive: true })
    await writeFile(
      join(tmpRepo, '.git', 'config'),
      '[remote "origin"]\n\turl = git@github.com:julianjab/julian-ia-flow.git\n',
      'utf-8',
    )
  })

  it('discovers owner+repo from git config at the mapped path', async () => {
    await saveProviderConfig(baseConfig({ 'ia-flow': { path: tmpRepo } }))
    const result = await resolveGithubRepo('ia-flow', 'la-haus')
    expect(result.owner).toBe('julianjab')
    expect(result.repo).toBe('julian-ia-flow')
    expect(result.path).toBe(tmpRepo)
    await rm(tmpRepo, { recursive: true, force: true })
  })
})

describe('ProviderConfigSchema repoMappings', () => {
  it('accepts shorthand string entries', () => {
    const parsed = ProviderConfigSchema.parse(baseConfig({ 'ia-flow': 'julian-ia-flow' }))
    expect(parsed.repoMappings).toEqual({ 'ia-flow': 'julian-ia-flow' })
  })

  it('accepts object entries with owner/repo/path', () => {
    const cfg = baseConfig({
      'ia-flow': { githubOwner: 'julianjab', githubRepo: 'julian-ia-flow', path: '/tmp/x' },
    })
    expect(() => ProviderConfigSchema.parse(cfg)).not.toThrow()
  })

  it('accepts config with no repoMappings field', () => {
    const cfg = baseConfig()
    delete (cfg as Partial<ProviderConfig>).repoMappings
    expect(() => ProviderConfigSchema.parse(cfg)).not.toThrow()
  })
})

describe('saveProviderConfig round-trip', () => {
  it('persists repoMappings across save/load (shorthand strings are expanded to objects)', async () => {
    const mappings: RepoMapping = {
      'ia-flow': { githubOwner: 'julianjab', githubRepo: 'julian-ia-flow' },
      'other': 'other-remote',
    }
    await saveProviderConfig(baseConfig(mappings))
    const reloaded = await loadProviderConfig()
    // DB always stores as objects — shorthand strings are expanded on save
    expect(reloaded.repoMappings).toEqual({
      'ia-flow': { githubOwner: 'julianjab', githubRepo: 'julian-ia-flow' },
      'other': { githubRepo: 'other-remote' },
    })
  })
})
