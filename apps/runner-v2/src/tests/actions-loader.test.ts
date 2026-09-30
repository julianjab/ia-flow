import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Action } from '@ia-flow/agent-engine'
import { GithubClient } from '@ia-flow/github-api'
import { SlackClient } from '@ia-flow/slack-api'
import { NodeShellRunner, WorkspaceManager, WorkspaceSession } from '@ia-flow/workspace'
import type { RunnerServices } from '../actions/defineAction.js'
import { loadActions } from '../actions/loader.js'
import { AssistantDesk } from '../assistant/AssistantDesk.js'
import { loadRunnerConfig } from '../config/RunnerConfig.js'
import { workspaceTargetFor } from '../workspace/workspaceTarget.js'

/** En el tmp del sistema: las actions resuelven el contrato del runner por los módulos virtuales. */
const ROOT = join(tmpdir(), 'ia-flow-runner-test-configs')

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

const workspace = new WorkspaceManager(new NodeShellRunner(), {
  reposBase: join(ROOT, 'repos'),
  worktreeBase: join(ROOT, 'worktrees'),
})
const services: RunnerServices = {
  github: new GithubClient({ auth: { getToken: async () => 'test' } }),
  workspace,
  session: new WorkspaceSession(workspace, workspaceTargetFor),
  gitCredential: async () => undefined,
  slack: new SlackClient({ token: 'test' }),
  slackUsers: {},
  assistant: new AssistantDesk(),
  log: () => {},
}

/** `runner.yaml` con las actions globales y un proyecto inline por id, con las suyas si hay. */
function index(files: Record<string, string>, projects: string[], actions: string): string {
  const own = (id: string) =>
    Object.keys(files).some((path) => path.startsWith(`projects/${id}/actions/`))
      ? `, actions: ./projects/${id}/actions`
      : ''
  return [
    'sources:',
    `  actions: ${actions}`,
    ...(projects.length > 0 ? ['  projects:'] : []),
    ...projects.map((id) => `    ${id}: { board: https://github.com/orgs/o/projects/1${own(id)} }`),
  ].join('\n')
}

type Built = { id: string; scope: string; sourceId: string; project?: string }

async function mount(
  files: Record<string, string>,
  projects: string[] = ['a', 'b'],
  actions = './actions',
) {
  const dir = config({ 'runner.yaml': index(files, projects, actions), ...files })
  const cfg = loadRunnerConfig(dir)
  const loaded = await loadActions(cfg.actions, cfg.projects, services)
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

  it('takes the actions runner.yaml declares: a list of files or a glob, not the whole folder', async () => {
    const files = {
      'actions/one.ts': action('one', 'global'),
      'actions/two.ts': action('two', 'global'),
      'actions/three.ts': action('three', 'global'),
    }
    expect(
      (await mount(files, [], '[./actions/one.ts, ./actions/t*.ts]')).loaded.registered.runner,
    ).toEqual(['one', 'three', 'two'])
    expect((await mount(files, [], './actions/one.ts')).loaded.registered.runner).toEqual(['one'])
  })
})
