/**
 * La definición de `.config/` montada: lo que el engine hace por cada agente, los filtros de cada
 * nivel (proyecto → pipeline → paso) y que un error de config rompa el arranque, no la primera
 * corrida.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { type Agent, createEvent, isAgent, PauseAction } from '@ia-tools/agent-engine'
import type { MountedRunner } from '../boot.js'
import { applyRunnerEnv, loadRunnerConfig } from '../config/RunnerConfig.js'
import { CONFIG_DIR, configCopy, mountDry } from './helpers.js'

let mounted: MountedRunner

beforeAll(async () => {
  mounted = await mountDry()
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

  it('a project folder without its board in runner.yaml breaks the load', () => {
    const dir = configCopy({
      'runner.yaml': (s) => s.replace(/projects:\n {2}lahaus-ai-flow:[\s\S]*$/, 'projects: {}\n'),
    })
    expect(() => loadRunnerConfig(dir)).toThrow(/falta el board de projects\.lahaus-ai-flow/)
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
    await expect(mountDry(dir)).rejects.toThrow(/agente "refiner".*maxToolRound/s)
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
})

describe('injects y ifRunning', () => {
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

    for (const p of mounted.pipelines()) expect(['wait', 'skip']).toContain(p.ifRunning)
    expect(mounted.executions?.stats).toEqual({ running: 0, waiting: 0, paused: 0 })
  })
})
