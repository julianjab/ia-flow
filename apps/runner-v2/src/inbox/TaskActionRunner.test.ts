import { describe, expect, it } from 'bun:test'
import { Action } from '@ia-flow/agent-engine'
import { z } from 'zod'
import { type TaskActionDefs, TaskActionsSchema } from './TaskActionDef.js'
import {
  assertTaskActionsRegistered,
  availableTaskActions,
  runTaskAction,
  type TaskFacts,
} from './TaskActionRunner.js'

const defs: TaskActionDefs = TaskActionsSchema.parse({
  answer_and_unblock: {
    label: 'Responder y destrabar',
    available: [{ field: 'item.labels', op: 'contains', value: 'blocked' }],
    input: { comment: 'required' },
    steps: [
      { action: 'post_user_comment', with: { body: '{{input.comment}}' } },
      { action: 'update_issue', with: { removeLabels: ['blocked'] } },
      { action: 'update_issue', with: { status: '{{task.resume_stage}}' } },
    ],
  },
  approve_prd: {
    label: 'Aprobar',
    available: [{ field: 'item.status', op: 'eq', value: 'Refined' }],
    steps: [{ action: 'update_issue', with: { status: 'Build' } }],
  },
})

const facts = (
  labels: string[],
  status = 'Build',
  run: Record<string, string> = {},
): TaskFacts => ({
  item: { status, type: 'technical', repos: ['r'], labels, blocked: false },
  run,
  live: {},
  queue: { waiting: false },
  task: { idle_hours: 0, waiting_hours: 0, unlocks: 0, blocked_by: 0 },
})

/** Una action que anota lo que recibió, para ver orden e inputs. */
function recorder(calls: string[], name: string, fail?: string): Action {
  return new (class extends Action {
    readonly description = name
    readonly input = z.looseObject({})
    constructor() {
      super({ id: name })
    }
    async execute(input: Record<string, unknown>): Promise<string> {
      calls.push(`${name} ${JSON.stringify(input)}`)
      if (fail && calls.length === Number(fail)) throw new Error('GitHub dijo 500')
      return `${name} ok`
    }
  })()
}

describe('availableTaskActions', () => {
  it('offers only what the guard allows, in declaration order', () => {
    expect(availableTaskActions(defs, facts(['blocked'], 'Refined'))).toEqual([
      'answer_and_unblock',
      'approve_prd',
    ])
    expect(availableTaskActions(defs, facts([], 'Build'))).toEqual([])
  })

  it('a guard can read the last run', () => {
    const onlyAfterDoubt = TaskActionsSchema.parse({
      reply: {
        label: 'Responder',
        available: [{ field: 'run.exit', op: 'eq', value: 'doubt' }],
        steps: [{ action: 'post_user_comment' }],
      },
    })
    expect(availableTaskActions(onlyAfterDoubt, facts([], 'Build', { exit: 'doubt' }))).toEqual([
      'reply',
    ])
    expect(availableTaskActions(onlyAfterDoubt, facts([], 'Build', { exit: 'done' }))).toEqual([])
  })
})

describe('assertTaskActionsRegistered', () => {
  const projects = [{ id: 'p', taskActions: defs }]

  it('passes when every step names a registered action', () => {
    expect(() =>
      assertTaskActionsRegistered(
        projects,
        { runner: ['update_issue'], p: ['post_user_comment'] },
        'runner',
      ),
    ).not.toThrow()
  })

  it('names the action, the step owner and the project when one is missing', () => {
    expect(() =>
      assertTaskActionsRegistered(projects, { runner: ['update_issue'], p: [] }, 'runner'),
    ).toThrow(/proyecto p: taskActions.answer_and_unblock usa la action "post_user_comment"/)
  })
})

describe('runTaskAction', () => {
  const issue = { owner: 'o', repo: 'r', number: 7 }

  it('runs the steps in order, rendering input and the resume stage', async () => {
    const calls: string[] = []
    const done = await runTaskAction({
      def: defs.answer_and_unblock as NonNullable<TaskActionDefs[string]>,
      id: 'answer_and_unblock',
      issue,
      facts: facts(['blocked']),
      input: { comment: 'Sólo upgrades.' },
      actor: 'julian',
      resumeStage: 'Refine',
      instantiate: (name) => recorder(calls, name),
    })
    expect(calls).toEqual([
      'post_user_comment {"body":"Sólo upgrades."}',
      'update_issue {"removeLabels":["blocked"]}',
      'update_issue {"status":"Refine"}',
    ])
    expect(done).toHaveLength(3)
  })

  it('refuses before touching anything when it needs a stage it does not know', async () => {
    const calls: string[] = []
    await expect(
      runTaskAction({
        def: defs.answer_and_unblock as NonNullable<TaskActionDefs[string]>,
        id: 'answer_and_unblock',
        issue,
        facts: facts(['blocked']),
        input: { comment: 'x' },
        actor: 'julian',
        instantiate: (name) => recorder(calls, name),
      }),
    ).rejects.toMatchObject({ status: 409 })
    expect(calls).toEqual([])
  })

  it('stops at the first failing step and says how many already ran', async () => {
    const calls: string[] = []
    await expect(
      runTaskAction({
        def: defs.answer_and_unblock as NonNullable<TaskActionDefs[string]>,
        id: 'answer_and_unblock',
        issue,
        facts: facts(['blocked']),
        input: { comment: 'x' },
        actor: 'julian',
        resumeStage: 'Refine',
        // The second call fails: the comment is already published, the label is not removed.
        instantiate: (name) => recorder(calls, name, '2'),
      }),
    ).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining(
        'falló el paso 2 (update_issue): GitHub dijo 500; ya corrieron: 1',
      ),
    })
    expect(calls).toHaveLength(2)
  })

  it("keeps the status of a step's own rejection (a PR that cannot be merged is a 409)", async () => {
    const rejecting = new (class extends Action {
      readonly description = 'x'
      readonly input = z.looseObject({})
      constructor() {
        super({ id: 'check_pr_mergeable' })
      }
      execute(): never {
        throw Object.assign(new Error('PR #12 no se puede mergear: tiene conflictos (dirty)'), {
          status: 409,
        })
      }
    })()
    const merge = TaskActionsSchema.parse({
      merge: {
        label: 'Mergear',
        steps: [{ action: 'check_pr_mergeable' }, { action: 'merge_pr' }],
      },
    })
    const calls: string[] = []
    await expect(
      runTaskAction({
        def: merge.merge as NonNullable<TaskActionDefs[string]>,
        id: 'merge',
        issue,
        facts: { ...facts([]), pr: { number: 12, url: 'u' } },
        input: {},
        actor: 'julian',
        instantiate: (name) => (name === 'merge_pr' ? recorder(calls, name) : rejecting),
      }),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining('conflictos (dirty)') })
    // The merge itself never ran.
    expect(calls).toEqual([])
  })

  it('skips a step whose when does not hold', async () => {
    const calls: string[] = []
    const withGuard = TaskActionsSchema.parse({
      x: {
        label: 'x',
        steps: [
          { action: 'a', when: [{ field: 'item.labels', op: 'contains', value: 'blocked' }] },
          { action: 'b' },
        ],
      },
    })
    await runTaskAction({
      def: withGuard.x as NonNullable<TaskActionDefs[string]>,
      id: 'x',
      issue,
      facts: facts([]),
      input: {},
      actor: 'julian',
      instantiate: (name) => recorder(calls, name),
    })
    expect(calls).toEqual(['b {}'])
  })
})

describe('TaskActionsSchema', () => {
  it('rejects an action with no steps, an unknown key or a bad id', () => {
    expect(TaskActionsSchema.safeParse({ x: { label: 'x', steps: [] } }).success).toBe(false)
    expect(
      TaskActionsSchema.safeParse({ x: { label: 'x', steps: [{ action: 'a' }], extra: 1 } })
        .success,
    ).toBe(false)
    expect(
      TaskActionsSchema.safeParse({ 'Bad-Id': { label: 'x', steps: [{ action: 'a' }] } }).success,
    ).toBe(false)
  })
})
