/** Fixtures compartidas por los tests del intake: board simulado, deliveries crudos de ejemplo. */

import { vi } from 'bun:test'
import {
  createEvent,
  type DomainEvent,
  Engine,
  EventBus,
  StaticPipelineSource,
} from '@ia-tools/agent-pipeline'
import type { IntakeContext, IntakeProject } from '../actions/index.js'
import type { BoardIssue, BoardItem } from '../board-reader.js'
import { intakePipelines } from '../intake.js'

const BOARD = { owner: 'la-haus', number: 119 }
export const PROJECT: IntakeProject = {
  id: 'lahaus-ai-flow',
  board: BOARD,
  repos: '- subscriptions',
  branchPrefix: 'ia-flow/',
}
export const repository = {
  name: 'subscriptions',
  full_name: 'la-haus/subscriptions',
  owner: { login: 'la-haus' },
}

export function card(overrides: Partial<BoardIssue> = {}): BoardIssue {
  return {
    itemId: 'PVTI_1',
    board: BOARD,
    status: 'Build',
    type: 'technical',
    owner: 'la-haus',
    repo: 'subscriptions',
    number: 7,
    ...overrides,
  }
}

export function fakeIntake(
  item: Partial<BoardItem> = {},
  overrides: Partial<IntakeContext> = {},
): IntakeContext {
  const issue = card(item)
  return {
    projectForRepo: (owner, repo) =>
      owner === 'la-haus' && repo === 'subscriptions' ? PROJECT : undefined,
    projectForBoard: (board) => (board.number === 119 ? PROJECT : undefined),
    reader: { itemForIssue: vi.fn(async () => issue), issueForItem: vi.fn(async () => issue) },
    pullRequest: vi.fn(async () => ({ headRef: 'ia-flow/7', body: '' })),
    dependents: vi.fn(async () => []),
    taskContext: {
      load: vi.fn(async () => ({
        comments: '[2026-09-25 10:00 · issue · julian]\nfalta paginar',
        ci: 'success',
        pr: { number: 12, url: 'https://github.com/la-haus/subscriptions/pull/12' },
        blockers: [],
      })),
    },
    lastStatus: new Map(),
    log: () => {},
    ...overrides,
  }
}

/** Corre el evento crudo por las pipelines de entrada y devuelve lo que emitieron. */
export async function runIntake(
  event: string,
  payload: Record<string, unknown>,
  ctx: IntakeContext,
) {
  const bus = new EventBus()
  const emitted: DomainEvent[] = []
  // El engine NO se suscribe al bus: lo emitido se captura, no se vuelve a despachar.
  bus.subscribe('*', (e) => {
    emitted.push(e)
  })
  const engine = new Engine({ bus, pipelines: new StaticPipelineSource(intakePipelines(ctx)) })
  const outcome = await engine.dispatch(createEvent(`github.${event}`, payload))
  return { outcome, emitted }
}

export const itemPayload = (
  action: string,
  fieldValue?: Record<string, unknown>,
  contentType = 'Issue',
) => ({
  action,
  projects_v2_item: { node_id: 'PVTI_1', content_type: contentType },
  ...(fieldValue ? { changes: { field_value: fieldValue } } : {}),
})

export const commentPayload = (body: string, issue: Record<string, unknown> = {}) => ({
  action: 'created',
  issue: { title: 't', body: 'b', number: 7, labels: [{ name: 'backend' }], ...issue },
  comment: { id: 555, body },
  repository,
  sender: { login: 'julian' },
})

export const reviewPayload = (state: string) => ({
  action: 'submitted',
  pull_request: {
    number: 12,
    body: '',
    head: { ref: 'ia-flow/7', sha: 's' },
    base: { ref: 'main' },
  },
  review: { state, user: { login: 'rev' }, body: 'arreglá el test' },
  repository,
})

export const runPayload = (action: string, prs: unknown[], branch = 'feat/x') => ({
  action,
  workflow_run: {
    name: 'CI',
    status: 'completed',
    conclusion: 'failure',
    head_branch: branch,
    pull_requests: prs,
  },
  repository,
})
