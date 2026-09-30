import type { ExecutionSummary, Inbox, InboxItem, TaskDetail, TraceEntry } from '@ia-flow/shared'

export function item(over: Partial<InboxItem> = {}): InboxItem {
  return {
    ref: 'acme/api#7',
    project_id: 'core',
    title: 'Filtro por rango de precio',
    url: 'https://github.com/acme/api/issues/7',
    group: 'need',
    kind: 'merge',
    status: 'Review',
    labels: ['reviewed'],
    why: 'Review + reviewed · CI verde',
    since: '2026-01-01T10:00:00.000Z',
    actions: ['merge'],
    ...over,
  }
}

export function execution(over: Partial<ExecutionSummary> = {}): ExecutionSummary {
  return {
    id: 'ex1',
    pipeline_id: 'build',
    status: 'running',
    started_at: '2026-01-01T10:00:00.000Z',
    agent_id: 'implementer',
    ...over,
  }
}

export function inbox(
  items: InboxItem[],
  projects = [{ id: 'core', board: { owner: 'acme', number: 1 } }],
): Inbox {
  return { generated_at: '2026-01-01T10:05:00.000Z', projects, items }
}

export function trace(over: Partial<TraceEntry> = {}): TraceEntry {
  return {
    kind: 'log',
    name: 'fs_read src/index.ts',
    start_time: '2026-01-01T10:01:02.000Z',
    trace_id: 't1',
    span_id: 's1',
    execution_id: 'ex1',
    origin: 'agent',
    attributes: {},
    ...over,
  }
}

export function detail(it: InboxItem, over: Partial<TaskDetail> = {}): TaskDetail {
  return { item: it, executions: [], events: [], trace: [], ...over }
}
