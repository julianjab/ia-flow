import type { Task } from '@ia-flow/shared'

// Filesystem-backed task store. Each task is a single YAML file grouped
// by status into subdirectories under a well-known root (see the adapter
// for the concrete path).
export interface ITaskRepository {
  // Absolute path to the tasks root — the local file-watcher issue-manager
  // watches it directly.
  root(): string
  read(filePath: string): Promise<Task | null>
  save(task: Task): Promise<void>
  listAll(): Promise<Task[]>
  getById(id: string): Promise<Task | null>
  move(task: Task, newStatus: string): Promise<Task>
  update(task: Task): Promise<void>
  listStatuses(): Promise<string[]>
}
