import {
  createEvent,
  type DomainEvent,
  Engine,
  EventBus,
  InMemoryExecutionStore,
  ProviderRegistry,
  YIELD_TOOL_NAME,
} from '@ia-flow/agent-engine'
import { describe, expect, it, vi } from 'vitest'
import { sourceDir, yamlSource } from './fixtures.js'

const TASK = { repo: 'la-haus/subscriptions', issue: 1640 }
const onTask = (type: string, payload: Record<string, unknown> = {}): DomainEvent =>
  createEvent(type, payload, { scope: TASK })

/** Un implementer que corre hasta que el test lo suelta, y entonces cede si lo interrumpieron. */
function heldProvider() {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let started!: () => void
  const running = new Promise<void>((resolve) => {
    started = resolve
  })
  const providers = new ProviderRegistry()
    .register({
      id: 'held',
      run: async (ctx) => {
        started()
        await gate
        const read = (await ctx.inbox?.()) ?? []
        const yieldTool = ctx.tools.find((tool) => tool.name === YIELD_TOOL_NAME)
        if (read.length > 0 && yieldTool) {
          await yieldTool.handler({ progress: 'migración escrita; falta el endpoint' })
        }
        return { outcome: 'success' }
      },
    })
    .register({ id: 'done', run: async () => ({ outcome: 'success' }) })
  return { providers, release, running }
}

const FILES = {
  'source.yaml': `
id: flow
onInterrupt:
  to:
    - function: comment
      with:
        body: "⏸️ {{steps.interruption.agent}} se interrumpió: {{steps.interruption.reason}}. Quedó en: {{steps.interruption.progress}}"
`,
  'agents/implementer.yaml': `
id: implementer
provider: held
prompt: "Implementá el issue #{{issue}}"
routes:
  done:
    to: [{ function: moveToReview }]
`,
  'agents/reviewer.yaml': `
id: reviewer
provider: done
prompt: "Revisá"
`,
  'pipelines/build.yaml': `
id: build
on: [build]
do:
  - { agent: implementer }
`,
  'pipelines/review.yaml': `
id: review
on: [status_changed]
when: [{ field: status, op: eq, value: Review }]
ifRunning: interrupt
interruptOn:
  - on: [status_changed]
do:
  - { agent: reviewer }
  - { function: reviewed }
`,
}

describe('ifRunning: interrupt, from YAML', () => {
  it('a status change interrupts the running agent: the project onInterrupt comments why and where it stopped', async () => {
    const { providers, release, running } = heldProvider()
    const log: string[] = []
    const comment = vi.fn((_ctx: unknown, input?: Record<string, unknown>) => {
      log.push(String(input?.body))
    })
    const moveToReview = vi.fn(() => void log.push('moveToReview'))
    const reviewed = vi.fn(() => void log.push('reviewed'))
    const engine = new Engine({
      bus: new EventBus(),
      pipelines: yamlSource({
        dir: sourceDir(FILES),
        catalogs: { providers, functions: { comment, moveToReview, reviewed } },
      }),
      executions: new InMemoryExecutionStore(),
      interruptReason: (event) =>
        `la tarjeta pasó a ${(event.payload as { status: string }).status}`,
    })

    const build = engine.dispatch(onTask('build'))
    await running
    const review = engine.dispatch(onTask('status_changed', { status: 'Review' }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    release()
    await Promise.all([build, review])

    expect(log).toEqual([
      '⏸️ implementer se interrumpió: la tarjeta pasó a Review. Quedó en: migración escrita; falta el endpoint',
      'reviewed',
    ])
  })

  it('rejects an ifRunning it does not know', () => {
    const files = {
      ...FILES,
      'pipelines/review.yaml': FILES['pipelines/review.yaml'].replace('interrupt', 'cancel'),
    }
    expect(() => yamlSource({ dir: sourceDir(files) })).toThrow(/pipelines\/review\.yaml/)
  })

  it('ifQueued: replace by default, keep when the pipeline says so', () => {
    const files = {
      ...FILES,
      'pipelines/comment.yaml': `
id: comment
on: [issue_comment]
ifQueued: keep
do:
  - { agent: implementer }
`,
    }
    const { providers } = heldProvider()
    const noop = () => undefined
    const pipelines = yamlSource({
      dir: sourceDir(files),
      catalogs: { providers, functions: { comment: noop, moveToReview: noop, reviewed: noop } },
    }).list()
    const ifQueued = Object.fromEntries(pipelines.map((p) => [p.id, p.ifQueued]))
    expect(ifQueued).toEqual({ build: 'replace', comment: 'keep', review: 'replace' })
  })
})
