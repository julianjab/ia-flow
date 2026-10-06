import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRunnerConfig, type RunnerConfig, runnerPathOf } from './RunnerConfig.js'

/** Una config mínima en el tmp del sistema: un proyecto inline con `project`. */
function config(project: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ia-flow-runner-config-'))
  writeFileSync(
    join(dir, 'runner.yaml'),
    `sources:\n  projects:\n    p:\n      board: https://github.com/orgs/o/projects/1\n${project}`,
  )
  return dir
}

describe('project.yaml board', () => {
  const withBoard = (url: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'ia-flow-runner-config-'))
    writeFileSync(join(dir, 'runner.yaml'), `sources:\n  projects:\n    p:\n      board: ${url}\n`)
    return dir
  }

  it('takes the board of an org', () => {
    const board = loadRunnerConfig(withBoard('https://github.com/orgs/o/projects/1')).projects[0]
      ?.board
    expect(board).toEqual({ owner: 'o', number: 1, ownerKind: 'orgs' })
  })

  it('takes the board of a personal account', () => {
    const board = loadRunnerConfig(withBoard('https://github.com/users/julianjab/projects/2'))
      .projects[0]?.board
    expect(board).toEqual({ owner: 'julianjab', number: 2, ownerKind: 'users' })
  })

  it('rejects a url that is not a Project v2', () => {
    expect(() => loadRunnerConfig(withBoard('https://github.com/julianjab/ia-flow'))).toThrow()
  })
})

describe('project.yaml when', () => {
  it('without when, every card of the board is the project', () => {
    expect(loadRunnerConfig(config('')).projects[0]?.when).toEqual([])
  })

  it('takes rows over the card (item.*)', () => {
    const cfg = loadRunnerConfig(
      config('      when:\n        - { field: item.labels, op: notContains, value: blocked }\n'),
    )
    expect(cfg.projects[0]?.when).toEqual([
      { field: 'item.labels', op: 'notContains', value: 'blocked' },
    ])
  })

  it('rejects a field outside the card: the inbox could not evaluate it', () => {
    expect(() =>
      loadRunnerConfig(config('      when:\n        - { field: task.branch, op: exists }\n')),
    ).toThrow(/sólo mira la card/)
  })

  it('label is not a project key any more', () => {
    expect(() => loadRunnerConfig(config('      label: blocked\n'))).toThrow(/inválido/)
  })
})

describe('which runner.yaml', () => {
  it('a folder means its runner.yaml; a file is used as is', () => {
    const dir = config('')
    expect(runnerPathOf(dir)).toBe(join(dir, 'runner.yaml'))
    expect(runnerPathOf(join(dir, 'runner.yaml'))).toBe(join(dir, 'runner.yaml'))
  })

  it('a runner.local.yaml next to the real one: its relative paths are the same folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ia-flow-runner-local-'))
    mkdirSync(join(dir, 'projects', 'p'), { recursive: true })
    const project = 'board: https://github.com/orgs/o/projects/1\n'
    writeFileSync(join(dir, 'projects', 'p', 'project.yaml'), project)
    writeFileSync(join(dir, 'projects', 'p', 'project.local.yaml'), `${project}branchPrefix: x/\n`)
    writeFileSync(
      join(dir, 'runner.yaml'),
      'sources:\n  projects:\n    p: ./projects/p/project.yaml\n',
    )
    writeFileSync(
      join(dir, 'runner.local.yaml'),
      'sources:\n  projects:\n    p: ./projects/p/project.local.yaml\n',
    )
    const local = loadRunnerConfig(join(dir, 'runner.local.yaml'))
    expect(local.runnerPath).toBe(join(dir, 'runner.local.yaml'))
    expect(local.dir).toBe(dir)
    expect(local.projects[0]?.branchPrefix).toBe('x/')
    expect(loadRunnerConfig(dir).projects[0]?.branchPrefix).toBeUndefined()
  })
})

describe('capabilities', () => {
  it('without sources.capabilities, the runner fulfils all of them with its own agents', () => {
    const spec = loadRunnerConfig(config('')).source.spec()
    expect(spec.source).toMatchObject({
      capabilities: {
        assistant: { agent: 'assistant' },
        'assistant.runner-improvements': { agent: 'runner-improvements' },
        whenText: { agent: 'text-classifier' },
        fileFocus: { agent: 'file-focus' },
        branchName: { agent: 'branch-namer' },
      },
    })
    const ids = [spec.agents].flat().map((doc) => (doc as { id?: string }).id)
    expect(ids).toEqual([
      'assistant',
      'runner-improvements',
      'text-classifier',
      'file-focus',
      'branch-namer',
      'retrospective',
    ])
  })

  it('the assistant agents come out of their capabilities, without what only the web reads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ia-flow-runner-caps-'))
    writeFileSync(
      join(dir, 'runner.yaml'),
      [
        'sources:',
        '  capabilities:',
        '    assistant.costs: { agent: my-costs, label: Costos }',
        '    assistant: { agent: my-assistant }',
        '',
      ].join('\n'),
    )
    const cfg = loadRunnerConfig(dir)
    const capabilities = (cfg.source.spec().source as { capabilities: Record<string, unknown> })
      .capabilities
    // El paso que cumple la capacidad no recibe `label` ni `description`.
    expect(capabilities.assistant).toEqual({ agent: 'my-assistant' })
    expect(capabilities['assistant.costs']).toEqual({ agent: 'my-costs' })
    // El de siempre primero; uno que se pisa sin `label` conserva el del runner.
    expect(cfg.assistantAgents()).toEqual([
      { id: 'assistant', label: 'Operación', description: 'Qué pasó, por qué y qué hacer' },
      {
        id: 'assistant.runner-improvements',
        label: 'Mejoras del runner',
        description: 'Fallas del proceso → issues en ia-flow',
      },
      { id: 'assistant.costs', label: 'Costos' },
    ])
  })

  it('a capability the config declares wins over the default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ia-flow-runner-caps-'))
    writeFileSync(
      join(dir, 'runner.yaml'),
      'sources:\n  capabilities:\n    whenText: { agent: my-classifier }\n',
    )
    const spec = loadRunnerConfig(dir).source.spec()
    expect(spec.source).toMatchObject({
      capabilities: { whenText: { agent: 'my-classifier' }, assistant: { agent: 'assistant' } },
    })
  })
})

describe('retrospective', () => {
  const pipelinesOf = (spec: ReturnType<RunnerConfig['source']['spec']>) =>
    [spec.pipelines ?? []].flat() as Array<{ id: string; on: string[]; do: unknown[] }>
  const agentOf = (spec: ReturnType<RunnerConfig['source']['spec']>) =>
    ([spec.agents].flat() as Array<{ id?: string; actions?: unknown[] }>).find(
      (doc) => doc.id === 'retrospective',
    )

  it('comes on: a global pipeline on a merged PR, its agent proposing to ia-flow', () => {
    const spec = loadRunnerConfig(config('')).source.spec()
    expect(pipelinesOf(spec)).toEqual([
      expect.objectContaining({
        id: 'retrospective',
        on: ['pull_request'],
        when: [
          { field: 'action', op: 'eq', value: 'closed' },
          { field: 'pr.merged', op: 'eq', value: true },
        ],
        do: [{ agent: 'retrospective' }],
      }),
    ])
    expect(agentOf(spec)?.actions).toEqual([
      'assistant',
      { action: 'propose_improvement', options: { engine: 'julianjab/ia-flow' } },
    ])
  })

  it('takes the repos of each target and keeps the pipelines of the config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ia-flow-runner-retro-'))
    writeFileSync(
      join(dir, 'runner.yaml'),
      [
        'retrospective:',
        '  repos: { engine: o/engine, config: o/deploy }',
        'sources:',
        '  pipelines:',
        '    - { id: intake, on: [github.issues], do: [{ action: resolve_task }] }',
        '',
      ].join('\n'),
    )
    const spec = loadRunnerConfig(dir).source.spec()
    expect(pipelinesOf(spec).map((pipeline) => pipeline.id)).toEqual(['intake', 'retrospective'])
    expect(agentOf(spec)?.actions).toContainEqual({
      action: 'propose_improvement',
      options: { engine: 'o/engine', config: 'o/deploy' },
    })
  })

  it('a deploy turns it off', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ia-flow-runner-retro-'))
    writeFileSync(join(dir, 'runner.yaml'), 'retrospective: { enabled: false }\n')
    const spec = loadRunnerConfig(dir).source.spec()
    expect(pipelinesOf(spec)).toEqual([])
    expect(agentOf(spec)).toBeUndefined()
  })

  it('rejects a repo that is not owner/repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ia-flow-runner-retro-'))
    writeFileSync(join(dir, 'runner.yaml'), 'retrospective: { repos: { config: deploy } }\n')
    expect(() => loadRunnerConfig(dir)).toThrow(/owner\/repo/)
  })
})

describe('runner.yaml systemPrompts', () => {
  function withPrompts(prompts: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'ia-flow-runner-config-'))
    writeFileSync(join(dir, 'runner.yaml'), prompts)
    return dir
  }

  it('is the catalog the engine resolves by id', () => {
    const cfg = loadRunnerConfig(
      withPrompts('systemPrompts:\n  - { id: reglas, text: Reglas de la casa. }\n'),
    )
    expect(cfg.systemPrompts.resolve('reglas')).toBe('Reglas de la casa.')
    expect(cfg.systemPrompts.resolve('nope')).toBeUndefined()
  })

  it('rejects two prompts with the same id', () => {
    expect(() =>
      loadRunnerConfig(
        withPrompts('systemPrompts:\n  - { id: a, text: x }\n  - { id: a, text: y }\n'),
      ),
    ).toThrow(/mismo id/)
  })
})

describe('project.yaml board: { kind: issues }', () => {
  const withIssuesBoard = (board: string, repos: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'ia-flow-runner-config-'))
    writeFileSync(
      join(dir, 'runner.yaml'),
      `sources:\n  projects:\n    p:\n      board:\n${board}      repos:\n${repos}`,
    )
    return dir
  }
  const repo = '        - { name: ia-flow, githubOwner: julianjab, githubRepo: ia-flow }\n'
  const columns = '        kind: issues\n        statuses: [Todo, Build, Done]\n'

  it('takes the issues of the catalog repos as the board, owned by the first repo', () => {
    const project = loadRunnerConfig(withIssuesBoard(columns, repo)).projects[0]
    expect(project?.boardKind).toBe('issues')
    expect(project?.board).toEqual({ owner: 'julianjab', number: 0 })
    expect(project?.issuesBoard).toEqual({ statuses: ['Todo', 'Build', 'Done'] })
  })

  it('takes the declared columns and the label prefix', () => {
    const board =
      '        kind: issues\n        statuses: [Todo, Build, Done]\n        statusPrefix: "estado:"\n'
    const project = loadRunnerConfig(withIssuesBoard(board, repo)).projects[0]
    expect(project?.issuesBoard).toEqual({
      statuses: ['Todo', 'Build', 'Done'],
      statusPrefix: 'estado:',
    })
  })

  it('a Project v2 url stays a Project v2', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ia-flow-runner-config-'))
    writeFileSync(
      join(dir, 'runner.yaml'),
      'sources:\n  projects:\n    p:\n      board: https://github.com/orgs/o/projects/1\n',
    )
    const project = loadRunnerConfig(dir).projects[0]
    expect(project?.boardKind).toBe('projects-v2')
    expect(project?.issuesBoard).toBeUndefined()
  })

  it('needs a repo to read the issues of', () => {
    expect(() => loadRunnerConfig(withIssuesBoard(columns, '        []\n'))).toThrow(
      /necesita algún repo/,
    )
  })

  it('needs the GitHub owner and repo of every catalog repo', () => {
    expect(() =>
      loadRunnerConfig(withIssuesBoard(columns, '        - { name: ia-flow }\n')),
    ).toThrow(/necesita githubOwner y githubRepo en cada repo \(falta en "ia-flow"\)/)
  })

  it('needs the declared columns: a label cannot say how a column is capitalized', () => {
    // En un project.yaml aparte (lo habitual) el error dice qué falta; inline, la unión
    // string | proyecto de runner.yaml lo reduce a "Invalid input".
    const dir = mkdtempSync(join(tmpdir(), 'ia-flow-runner-config-'))
    writeFileSync(join(dir, 'runner.yaml'), 'sources:\n  projects:\n    p: ./project.yaml\n')
    writeFileSync(
      join(dir, 'project.yaml'),
      'board:\n  kind: issues\nrepos:\n  - { name: ia-flow, githubOwner: julianjab, githubRepo: ia-flow }\n',
    )
    expect(() => loadRunnerConfig(dir)).toThrow(/statuses/)
  })

  it('rejects a board kind it does not know', () => {
    expect(() => loadRunnerConfig(withIssuesBoard('        kind: trello\n', repo))).toThrow()
  })
})
