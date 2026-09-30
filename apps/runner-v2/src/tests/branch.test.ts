import { describe, expect, it } from 'bun:test'
import {
  Capabilities,
  createEvent,
  EventBus,
  FunctionAction,
  type PipelineExecutionContext,
} from '@ia-flow/agent-engine'
import type { GithubTaskReader } from '@ia-flow/github-tools'
import { sanitizeBranchName, TaskBranches } from '../intake/branch.js'

const reader = (linked: string[] = []) =>
  ({ linkedBranches: async () => linked }) as unknown as GithubTaskReader
const ISSUE = { title: 'Paginar leads', body: 'el listado no pagina', type: 'technical' }

function ctx(branch?: string | Error): PipelineExecutionContext {
  const bus = new EventBus()
  const namer = new FunctionAction({
    fn: () => {
      if (branch instanceof Error) throw branch
      return { branch }
    },
  })
  return {
    event: createEvent('e', {}),
    steps: {},
    bus,
    pipelineId: 'intake',
    ...(branch !== undefined ? { capabilities: new Capabilities({ branchName: namer }, bus) } : {}),
  }
}

let n = 100
const task = () => ({ owner: 'la-haus', repo: 'subscriptions', number: n++ })

describe('TaskBranches', () => {
  it('with a prefix, the branch is <prefix><number> and GitHub is not asked', async () => {
    expect(
      await new TaskBranches(reader(['otra']), 'ia-flow/').known({ ...task(), number: 7 }),
    ).toBe('ia-flow/7')
  })

  it('without a prefix, the branch already linked to the issue wins', async () => {
    expect(await new TaskBranches(reader(['feat/x']), undefined).known(task())).toBe('feat/x')
    expect(await new TaskBranches(reader(), undefined).known(task())).toBeUndefined()
  })

  it('proposes a name with the branchName capability, sanitized, and keeps it for the task', async () => {
    const branches = new TaskBranches(reader(), undefined)
    const t = task()
    expect(await branches.propose(t, ISSUE, ctx('Feat/Paginar Leads!'))).toBe('feat/paginar-leads')
    expect(await branches.propose(t, ISSUE, ctx('fix/otra-cosa'))).toBe('feat/paginar-leads')
  })

  it('falls back to task/<n> without the capability, or if it fails', async () => {
    const branches = new TaskBranches(reader(), undefined)
    const a = task()
    const b = task()
    expect(await branches.propose(a, ISSUE, ctx())).toBe(`task/${a.number}`)
    expect(await branches.propose(b, ISSUE, ctx(new Error('529')))).toBe(`task/${b.number}`)
  })
})

describe('sanitizeBranchName', () => {
  it('leaves a valid git ref', () => {
    expect(sanitizeBranchName('`feat/Paginar  leads`')).toBe('feat/paginar-leads')
    expect(sanitizeBranchName('/-fix//a--b-/')).toBe('fix/a-b')
    expect(sanitizeBranchName('!!!')).toBe('')
  })
})
