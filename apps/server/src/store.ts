import { existsSync } from 'fs'
import { join } from 'path'
import type { Task } from '@ia-flow/shared'
import { mkdir, readFile, readdir, unlink, writeFile } from 'fs/promises'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

const TASKS_ROOT = join(import.meta.dir, '..', '..', '..', '..', 'tasks')

// 'queued' keeps its legacy dir name 'queue' for backward compatibility
const LEGACY_DIR_NAMES: Record<string, string> = {
  queued: 'queue',
}

function getStatusDir(status: string): string {
  const lower = status.toLowerCase()
  const dirName = LEGACY_DIR_NAMES[lower] ?? lower
  return join(TASKS_ROOT, dirName)
}

async function ensureStatusDir(status: string): Promise<string> {
  const dir = getStatusDir(status)
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
  return dir
}

export function getTasksRoot(): string {
  return TASKS_ROOT
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
  const dir = await ensureStatusDir(task.status)
  const filePath = join(dir, `${task.id}.yaml`)
  await writeFile(filePath, stringifyYaml(task), 'utf-8')
}

export async function getAllTasks(): Promise<Task[]> {
  const tasks: Task[] = []

  let entries: Awaited<ReturnType<typeof readdir>>
  try {
    if (!existsSync(TASKS_ROOT)) return []
    entries = await readdir(TASKS_ROOT, { withFileTypes: true })
  } catch {
    return []
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(TASKS_ROOT, entry.name)
    let files: string[]
    try {
      files = await readdir(dir)
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.endsWith('.yaml')) continue
      const task = await readTask(join(dir, file))
      if (task) tasks.push(task)
    }
  }

  return tasks.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
}

export async function getTask(id: string): Promise<Task | null> {
  if (!existsSync(TASKS_ROOT)) return null

  let entries: Awaited<ReturnType<typeof readdir>>
  try {
    entries = await readdir(TASKS_ROOT, { withFileTypes: true })
  } catch {
    return null
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const filePath = join(TASKS_ROOT, entry.name, `${id}.yaml`)
    if (existsSync(filePath)) {
      return readTask(filePath)
    }
  }
  return null
}

export async function moveTask(task: Task, newStatus: string): Promise<Task> {
  const oldDir = getStatusDir(task.status)
  const newDir = await ensureStatusDir(newStatus)
  const oldPath = join(oldDir, `${task.id}.yaml`)
  const newPath = join(newDir, `${task.id}.yaml`)

  const updated: Task = { ...task, status: newStatus as Task['status'] }

  if (newStatus === 'approved') {
    updated.approved_at = new Date().toISOString()
  }

  await writeFile(newPath, stringifyYaml(updated), 'utf-8')
  if (existsSync(oldPath) && oldPath !== newPath) {
    await unlink(oldPath)
  }

  return updated
}

export async function updateTask(task: Task): Promise<void> {
  const dir = getStatusDir(task.status)
  const filePath = join(dir, `${task.id}.yaml`)
  await writeFile(filePath, stringifyYaml(task), 'utf-8')
}

// Reverse map: dir name → status name
const DIR_TO_STATUS: Record<string, string> = Object.fromEntries(
  Object.entries(LEGACY_DIR_NAMES).map(([status, dir]) => [dir, status]),
)

export async function listTaskStatuses(): Promise<string[]> {
  if (!existsSync(TASKS_ROOT)) return []
  try {
    const entries = await readdir(TASKS_ROOT, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => DIR_TO_STATUS[e.name] ?? e.name)
  } catch {
    return []
  }
}
