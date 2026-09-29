import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { Action } from '@ia-tools/agent-engine'
import { GithubClient } from '@ia-tools/github-api'
import type { RunnerServices } from '../actions/defineAction.js'
import { loadActions } from '../actions/loader.js'
import type { ProjectConfig } from '../config/RunnerConfig.js'

/** Dentro de la app: las actions importan el contrato del runner y se resuelven desde donde están. */
const ROOT = resolve(import.meta.dir, '../../.state/test-configs')

/** Una action que dice quién la armó: su scope y la fuente que la pidió. */
const action = (
  id: string,
  scope: string,
) => `import { defineAction } from '@ia-flow/runner-v2/actions'
export default defineAction({
  id: '${id}',
  create: (ctx) => ({ id: '${id}', scope: '${scope}', sourceId: ctx.sourceId, project: ctx.project?.id }),
})
`

function config(files: Record<string, string>): string {
  mkdirSync(ROOT, { recursive: true })
  const dir = mkdtempSync(join(ROOT, 'actions-'))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  return dir
}

const services: RunnerServices = {
  github: new GithubClient({ auth: { getToken: async () => 'test' } }),
  dryRun: true,
  live: false,
  log: () => {},
  missingTools: new Set(),
}

const project = (dir: string, id: string): ProjectConfig => ({
  id,
  dir: join(dir, 'projects', id),
  board: { owner: 'o', number: 1 },
  branchPrefix: 'p/',
  repos: [],
})

type Built = { id: string; scope: string; sourceId: string; project?: string }

async function mount(files: Record<string, string>, projects: string[] = ['a', 'b']) {
  const dir = config(files)
  const loaded = await loadActions(
    dir,
    projects.map((id) => project(dir, id)),
    services,
  )
  const build = (name: string, sourceId: string) => {
    const provider = loaded.catalogs.actions?.[name] as (r: unknown) => Action
    return provider({ sourceId, options: {} }) as unknown as Built
  }
  return { loaded, build }
}

describe('loadActions', () => {
  it('a project sees its own actions first, then the global ones; the global source only the global', async () => {
    const { loaded, build } = await mount({
      'actions/shared.ts': action('shared', 'global'),
      'actions/only_global.ts': action('only_global', 'global'),
      'projects/a/actions/shared.ts': action('shared', 'a'),
      'projects/a/actions/only_a.ts': action('only_a', 'a'),
    })
    expect(build('shared', 'a')).toEqual({ id: 'shared', scope: 'a', sourceId: 'a', project: 'a' })
    expect(build('shared', 'b')).toMatchObject({ scope: 'global', project: 'b' })
    expect(build('shared', 'runner')).toMatchObject({ scope: 'global', sourceId: 'runner' })
    expect(build('only_global', 'a')).toMatchObject({ scope: 'global', project: 'a' })
    expect(() => build('only_a', 'b')).toThrow(
      /la action "only_a" no está en b ni entre las globales/,
    )
    expect(loaded.registered).toEqual({
      runner: ['only_global', 'shared'],
      a: ['only_a', 'shared'],
      b: [],
    })
  })

  it('skips _lib/ and tests', async () => {
    const { loaded } = await mount({
      'actions/one.ts': action('one', 'global'),
      'actions/_lib/helper.ts': 'export const x = 1\n',
      'actions/one.test.ts': 'export default 1\n',
    })
    expect(loaded.registered.runner).toEqual(['one'])
  })

  it('an id twice in the same scope, or a file without a definition, breaks the load', async () => {
    await expect(
      mount({ 'actions/a.ts': action('dup', 'global'), 'actions/b.ts': action('dup', 'global') }),
    ).rejects.toThrow(/b\.ts: "dup" ya está definida en .*a\.ts/)
    await expect(mount({ 'actions/x.ts': 'export default 42\n' })).rejects.toThrow(
      /x\.ts: tiene que exportar por default una definición/,
    )
  })
})
