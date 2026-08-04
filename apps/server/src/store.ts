import { readdir, readFile, writeFile, mkdir, rename, unlink } from 'fs/promises'
import { existsSync } from 'fs'
import { join, basename } from 'path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { Task, TaskStatus } from '@ia-flow/shared'

const TASKS_ROOT = join(import.meta.dir, '..', '..', '..', '..', 'tasks')

const STATUS_DIRS: Record<TaskStatus, string> = {
  queued: join(TASKS_ROOT, 'queue'),
  refining: join(TASKS_ROOT, 'refining'),
  refined: join(TASKS_ROOT, 'refined'),
  approved: join(TASKS_ROOT, 'approved'),
}

async function ensureDirs() {
  for (const dir of Object.values(STATUS_DIRS)) {
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true })
    }
  }
}

export async function readTask(filePath: string): Promise<Task | null> {
  try {
    const content = await readFile(filePath, 'utf-8')
    return parseYaml(content) as Task
  } catch {
    return null
  }
}

export async function writeTask(task: Task): Promise<void> {
  await ensureDirs()
  const dir = STATUS_DIRS[task.status]
  const filePath = join(dir, `${task.id}.yaml`)
  await writeFile(filePath, stringifyYaml(task), 'utf-8')
}

export async function getAllTasks(): Promise<Task[]> {
  await ensureDirs()
  const tasks: Task[] = []

  for (const [, dir] of Object.entries(STATUS_DIRS)) {
    if (!existsSync(dir)) continue
    const files = await readdir(dir)
    for (const file of files) {
      if (!file.endsWith('.yaml')) continue
      const task = await readTask(join(dir, file))
      if (task) tasks.push(task)
    }
  }

  return tasks.sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  )
}

export async function getTask(id: string): Promise<Task | null> {
  for (const dir of Object.values(STATUS_DIRS)) {
    const filePath = join(dir, `${id}.yaml`)
    if (existsSync(filePath)) {
      return readTask(filePath)
    }
  }
  return null
}

export async function moveTask(task: Task, newStatus: TaskStatus): Promise<Task> {
  const oldDir = STATUS_DIRS[task.status]
  const newDir = STATUS_DIRS[newStatus]
  const oldPath = join(oldDir, `${task.id}.yaml`)
  const newPath = join(newDir, `${task.id}.yaml`)

  const updated: Task = { ...task, status: newStatus }

  if (newStatus === 'approved') {
    updated.approved_at = new Date().toISOString()
  }

  // Write to new location first, then remove old
  await writeFile(newPath, stringifyYaml(updated), 'utf-8')
  if (existsSync(oldPath) && oldPath !== newPath) {
    await unlink(oldPath)
  }

  return updated
}

export async function updateTask(task: Task): Promise<void> {
  const dir = STATUS_DIRS[task.status]
  const filePath = join(dir, `${task.id}.yaml`)
  await writeFile(filePath, stringifyYaml(task), 'utf-8')
}

export function getQueueDir(): string {
  return STATUS_DIRS.queued
}

export function getStatusDirs(): Record<TaskStatus, string> {
  return STATUS_DIRS
}
