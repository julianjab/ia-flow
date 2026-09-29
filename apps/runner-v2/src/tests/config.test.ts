/**
 * La definición de `.config/` montada: lo que el engine hace por cada agente, los filtros de cada
 * nivel (proyecto → pipeline → paso) y que un error de config rompa el arranque, no la primera
 * corrida.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { type Agent, createEvent, isAgent, PauseAction } from '@ia-flow/agent-engine'
import type { MountedRunner } from '../boot.js'
import { applyRunnerEnv, loadRunnerConfig } from '../config/RunnerConfig.js'
import { CONFIG_DIR, configCopy, mountForTest } from './helpers.js'

let mounted: MountedRunner

beforeAll(async () => {
  mounted = await mountForTest()
})
afterAll(() => mounted.stop())

const pipeline = (id: string) => mounted.pipelines().find((p) => p.id === id)
const agentOf = (id: string, agentId: string) =>
  pipeline(id)?.do.find((step): step is Agent => isAgent(step) && step.id === agentId)

describe('runner.yaml', () => {
  it('loads the projects with their board and repos, and the provider defaults', () => {
    const cfg = loadRunnerConfig(CONFIG_DIR)
    expect(cfg.projects.map((p) => [p.id, p.board])).toEqual([
      ['lahaus-ai-flow', { owner: 'la-haus', number: 119 }],
    ])
    expect(cfg.repos.some((repo) => repo.name === 'subscriptions')).toBe(true)
    expect(cfg.providers['anthropic-api']).toMatchObject({ maxToolRounds: expect.any(Number) })
  })

  it('rejects a misspelled key instead of ignoring it', () => {
    const dir = configCopy({ 'runner.yaml': (s) => s.replace('settings:', 'setings:') })
    expect(() => loadRunnerConfig(dir)).toThrow(/runner\.yaml: inválido/)
  })

  it('a project.yaml without its board breaks the load', () => {
    const dir = configCopy({
      'projects/lahaus-ai-flow/project.yaml': (s) => s.replace(/^board: .*$/m, ''),
    })
    expect(() => loadRunnerConfig(dir)).toThrow(/project\.yaml: inválido[\s\S]*board/)
  })

  it('the real environment wins over runner.yaml', () => {
    const before = process.env.IA_FLOW_GITHUB_APP_ID
    process.env.IA_FLOW_GITHUB_APP_ID = 'desde-el-env'
    try {
      const report = applyRunnerEnv(loadRunnerConfig(CONFIG_DIR))
      expect(report.overriddenByEnv).toContain('IA_FLOW_GITHUB_APP_ID')
      expect(process.env.IA_FLOW_GITHUB_APP_ID).toBe('desde-el-env')
    } finally {
      if (before === undefined) delete process.env.IA_FLOW_GITHUB_APP_ID
      else process.env.IA_FLOW_GITHUB_APP_ID = before
    }
  })

  it('settings.telemetry goes to the OTEL_* variables, unless the environment has them', () => {
    const names = [
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      'OTEL_SERVICE_NAME',
      'OTEL_DEPLOYMENT_ENVIRONMENT',
    ]
    const before = Object.fromEntries(names.map((name) => [name, process.env[name]]))
    for (const name of names) delete process.env[name]
    process.env.OTEL_SERVICE_NAME = 'desde-el-env'
    const dir = configCopy({
      // Lo que traiga el runner.yaml real se reemplaza por esto.
      'runner.yaml': (s) =>
        s
          .replace(/\n {2}telemetry:\n(?: {4}.*\n)*/, '\n')
          .replace(
            'settings:\n',
            'settings:\n  telemetry:\n    endpoint: http://localhost:4318\n    serviceName: runner\n',
          ),
    })
    try {
      const report = applyRunnerEnv(loadRunnerConfig(dir))
      expect(process.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://localhost:4318')
      expect(report.applied).toContain('OTEL_EXPORTER_OTLP_ENDPOINT')
      expect(process.env.OTEL_SERVICE_NAME).toBe('desde-el-env')
      expect(report.overriddenByEnv).toContain('OTEL_SERVICE_NAME')
    } finally {
      for (const name of names) {
        if (before[name] === undefined) delete process.env[name]
        else process.env[name] = before[name]
      }
    }
  })
})

describe('la cascada when', () => {
  it('the ownership label (only blocked cards) is not repeated in each pipeline — resolve_task filters it', () => {
    for (const p of mounted.pipelines()) {
      const repeated = p.trigger.when.some(
        (c) => c.field === 'item.labels' && c.op === 'contains' && c.value === 'blocked',
      )
      expect(repeated, p.id).toBe(false)
    }
  })

  it('only pipelines with an agent that cannot run on a blocked card wait for its blockers', () => {
    const gated = (id: string) =>
      pipeline(id)?.trigger.when.some((c) => c.field === 'item.blocked' && c.op === 'neq')
    expect(gated('build-arrival')).toBe(true)
    expect(gated('review')).toBe(true)
    // `comment` no se frena entera: cada paso decide (los refiners técnicos atienden igual).
    expect(gated('comment')).toBe(false)
  })
})

describe('providerConfig con la estructura del provider', () => {
  it('a typo in an agent providerConfig breaks the boot, not the first run', async () => {
    const dir = configCopy({
      'projects/lahaus-ai-flow/agents/10-refiner.yaml': (s) =>
        s.replace(/providerConfig:\n/, 'providerConfig:\n  maxToolRound: 50\n'),
    })
    await expect(mountForTest(dir)).rejects.toThrow(/agente "refiner".*maxToolRound/s)
  })
})

describe('lo que el engine hace por el implementer', () => {
  it('links the task branch on start, ensures the PR and waits for CI before Review', () => {
    for (const [id, agentId] of [
      ['build-arrival', 'implementer'],
      ['build-arrival', 'frontend-implementer'],
    ] as const) {
      const agent = agentOf(id, agentId)
      expect(agent?.id).toBe(agentId)
      expect([agent?.definition.onStart ?? []].flat().map((step) => step.id)).toEqual([
        'update_issue',
        'link_branch',
      ])

      const done = mounted
        .routesOf(pipeline(id) as never, agentId)
        .exits.find((exit) => exit.name === 'done')
      expect(done?.targets.map((target) => target.id)).toEqual(['ensure_pull_request', 'wait-ci'])
      const pause = done?.targets.find((target) => target.id === 'wait-ci') as PauseAction
      expect(pause).toBeInstanceOf(PauseAction)
      expect(pause.timeout?.afterMs).toBe(30 * 60_000)
      expect(pause.targetsOf('green').map((target) => target.id)).toEqual(['update_issue'])
      expect(pause.targetsOf('timeout').map((target) => target.id)).toEqual(['update_issue'])
    }
  })

  it('a failed run blocks the card: the project onError, reported by the agent', () => {
    const routes = mounted.routesOf(pipeline('build-arrival') as never, 'implementer')
    expect(routes.onError?.origin).toBe('project')
    expect(routes.report?.target.id).toBe('post_comment')
  })

  it('an interrupted agent comments why it stopped: the project onInterrupt', () => {
    const routes = mounted.routesOf(pipeline('build-arrival') as never, 'implementer')
    expect(routes.onInterrupt?.origin).toBe('project')
    expect(routes.onInterrupt?.route.to).toMatchObject([{ action: { id: 'post_notice' } }])
  })
})

describe('injects, ifRunning e ifQueued', () => {
  it('the working agents accept human comments and change requests', () => {
    const implementer = agentOf('build-arrival', 'implementer')

    const human = createEvent('issue_comment', { action: 'created', body: 'usá el enum' })
    const own = createEvent('issue_comment', {
      action: 'created',
      body: 'listo\n<!-- ia-flow: x -->',
    })
    const changes = createEvent('pull_request_review', {
      action: 'submitted',
      state: 'changes_requested',
    })
    expect(implementer?.accepts(human)).toBe(true)
    expect(implementer?.accepts(own)).toBe(false)
    expect(implementer?.accepts(changes)).toBe(true)

    expect(mounted.executions?.stats).toEqual({ running: 0, waiting: 0, paused: 0 })
  })

  it('a status change cuts the agent of another column; an edit of the card only waits', () => {
    const interrupting = ['refine', 'build-arrival', 'build-reentry']
    const statusChanged = createEvent('issue.status_changed', { from: 'Build', to: 'Refine' })
    const edited = createEvent('projects_v2_item.edited', { fieldName: 'Task Type' })
    for (const id of interrupting) {
      expect(pipeline(id)?.ifRunning).toBe('interrupt')
      expect(pipeline(id)?.interrupts(statusChanged)).toBe(true)
    }
    // Las que escuchan más que un cambio de status sólo interrumpen con él.
    for (const id of ['refine', 'build-reentry']) {
      expect(pipeline(id)?.interrupts(edited)).toBe(false)
    }
    expect(pipeline('build-arrival')?.on).toEqual(['issue.status_changed'])
    for (const p of mounted.pipelines()) {
      if (!interrupting.includes(p.id)) expect(p.ifRunning).toBe('wait')
    }
  })

  it('every comment counts: the comment rule keeps its queue, the rest replace theirs', () => {
    for (const p of mounted.pipelines()) {
      expect(p.ifQueued).toBe(p.id === 'comment' ? 'keep' : 'replace')
    }
  })
})

describe('runner.yaml as the index', () => {
  const ids = (mounted: MountedRunner, id: string) =>
    mounted.sources
      .find((entry) => entry.id === id)
      ?.source.list()
      .map((p) => p.id) ?? []

  it('mounts exactly what it declares: the inline intake, plus a pipeline added to the list', async () => {
    const dir = configCopy({
      'runner.yaml': (s) =>
        s.replace(
          /^ {2}pipelines:$/m,
          '  pipelines:\n    - { id: ping, on: [ping], do: [{ emit: pong }] }',
        ),
    })
    const mounted = await mountForTest(dir)
    try {
      expect(ids(mounted, 'runner')).toEqual(['ping', 'intake', 'intake-unblock'])
      expect(ids(mounted, 'lahaus-ai-flow')).toHaveLength(8)
    } finally {
      mounted.stop()
    }
  })

  it('a project declared in runner.yaml that points nowhere breaks the load', () => {
    const dir = configCopy({
      'runner.yaml': (s) =>
        s.replace('./projects/lahaus-ai-flow/project.yaml', './projects/nope/project.yaml'),
    })
    expect(() => loadRunnerConfig(dir)).toThrow(/nope\/project\.yaml: no se pudo leer/)
  })
})
