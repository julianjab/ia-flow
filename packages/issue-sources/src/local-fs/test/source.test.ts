import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Task } from '@ia-flow/shared'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import type { ITaskRepository, SourceItem } from '../../contract.js'
import { LocalProjectSource } from '../source.js'

// Minimal in-memory ITaskRepository backed by a real directory so
// chokidar (used by LocalProjectSource.watch()) has something to watch.
// `read()`/`getById()` are keyed by task id, independent of file content —
// the on-disk file only needs to exist for chokidar's `add` event to fire.
class FakeTaskRepository implements ITaskRepository {
  private tasks = new Map<string, Task>()

  constructor(private readonly dir: string) {}

  seed(task: Task): void {
    this.tasks.set(task.id, task)
  }

  root(): string {
    return this.dir
  }
  async read(filePath: string): Promise<Task | null> {
    const id =
      filePath
        .split('/')
        .pop()
        ?.replace(/\.yaml$/, '') ?? ''
    return this.tasks.get(id) ?? null
  }
  async save(task: Task): Promise<void> {
    this.tasks.set(task.id, task)
  }
  async listAll(): Promise<Task[]> {
    return [...this.tasks.values()]
  }
  async getById(id: string): Promise<Task | null> {
    return this.tasks.get(id) ?? null
  }
  async move(task: Task, newStatus: string): Promise<Task> {
    const moved = { ...task, status: newStatus as Task['status'] }
    this.tasks.set(task.id, moved)
    return moved
  }
  async update(task: Task): Promise<void> {
    this.tasks.set(task.id, task)
  }
  async delete(id: string): Promise<void> {
    this.tasks.delete(id)
  }
  async listStatuses(): Promise<string[]> {
    return [...new Set([...this.tasks.values()].map((t) => t.status))]
  }
}

async function waitFor(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe('LocalProjectSource', () => {
  let dir: string
  let repo: FakeTaskRepository

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ia-flow-local-source-'))
    repo = new FakeTaskRepository(dir)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test('getItems() lists real tasks (no longer a stub returning [])', async () => {
    repo.seed({
      id: 't1',
      title: 'Task one',
      description: 'desc',
      type: 'functional',
      repos: ['repo-a'],
      status: 'queued',
      created_at: new Date().toISOString(),
    })
    const source = new LocalProjectSource(repo)
    const items = await source.getItems()
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe('t1')
    expect(items[0].status).toBe('queued')
  })

  test('toIssueItem() reconstructs description/type and preserves extra Task fields via meta', () => {
    const source = new LocalProjectSource(repo)
    const item: SourceItem = {
      id: 't1',
      title: 'Task one',
      status: 'queued',
      repos: 'repo-a, repo-b',
      meta: { description: 'desc', type: 'functional', prd: 'the prd body', issueNumber: 42 },
    }
    const issueItem = source.toIssueItem?.(item)
    expect(issueItem).toEqual({
      id: 't1',
      title: 'Task one',
      description: 'desc',
      type: 'functional',
      repos: ['repo-a', 'repo-b'],
      status: 'queued',
      meta: { prd: 'the prd body', issueNumber: 42 },
    })
  })

  test('watch() pushes a SourceItem when a task file is added, without any getItems() polling', async () => {
    const source = new LocalProjectSource(repo)
    const seen: SourceItem[][] = []
    const disposable = source.watch(
      (items) => {
        seen.push(items)
      },
      { mode: 'webhook', projectId: 'p1' },
    )

    const task: Task = {
      id: 't-new',
      title: 'New task',
      description: 'desc',
      type: 'functional',
      repos: ['repo-a'],
      status: 'queued',
      created_at: new Date().toISOString(),
    }
    repo.seed(task)
    await writeFile(join(dir, 't-new.yaml'), 'placeholder: true\n')

    await waitFor(() => seen.length > 0)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toHaveLength(1)
    expect(seen[0][0].id).toBe('t-new')

    disposable.dispose()
  }, 8000)

  test('watch() ignores non-.yaml files', async () => {
    const source = new LocalProjectSource(repo)
    let calls = 0
    const disposable = source.watch(
      () => {
        calls++
      },
      { mode: 'webhook', projectId: 'p1' },
    )

    await writeFile(join(dir, 'notes.txt'), 'not a task\n')
    await new Promise((r) => setTimeout(r, 700))
    expect(calls).toBe(0)

    disposable.dispose()
  }, 8000)

  test('dispose() stops the watcher — later file adds are not dispatched', async () => {
    const source = new LocalProjectSource(repo)
    let calls = 0
    const disposable = source.watch(
      () => {
        calls++
      },
      { mode: 'webhook', projectId: 'p1' },
    )
    disposable.dispose()

    repo.seed({
      id: 't-after-dispose',
      title: 'x',
      description: '',
      type: 'functional',
      repos: [],
      status: 'queued',
      created_at: new Date().toISOString(),
    })
    await writeFile(join(dir, 't-after-dispose.yaml'), 'placeholder: true\n')
    await new Promise((r) => setTimeout(r, 700))
    expect(calls).toBe(0)
  }, 8000)
})
