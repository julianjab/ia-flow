import { existsSync } from 'fs'
import type { Dirent } from 'fs'
import { join } from 'path'
import type { Task } from '@ia-flow/shared'
import { mkdir, readFile, readdir, unlink, writeFile } from 'fs/promises'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { ITaskRepository } from '../../domain/ports/ITaskRepository.js'

type DirentString = Dirent<string>

// 'queued' keeps its legacy dir name 'queue' for backward compatibility.
const LEGACY_DIR_NAMES: Record<string, string> = {
  queued: 'queue',
}
// Reverse map: dir name → status name.
const DIR_TO_STATUS: Record<string, string> = Object.fromEntries(
  Object.entries(LEGACY_DIR_NAMES).map(([status, dir]) => [dir, status]),
)

export class FsTaskRepository implements ITaskRepository {
  constructor(private tasksRoot: string) {}

  root(): string {
    return this.tasksRoot
  }

  private statusDir(status: string): string {
    const lower = status.toLowerCase()
    const dirName = LEGACY_DIR_NAMES[lower] ?? lower
    return join(this.tasksRoot, dirName)
  }

  private async ensureStatusDir(status: string): Promise<string> {
    const dir = this.statusDir(status)
    if (!existsSync(dir)) await mkdir(dir, { recursive: true })
    return dir
  }

  async read(filePath: string): Promise<Task | null> {
    try {
      const content = await readFile(filePath, 'utf-8')
      return parseYaml(content) as Task
    } catch {
      return null
    }
  }

  async save(task: Task): Promise<void> {
    const dir = await this.ensureStatusDir(task.status)
    const filePath = join(dir, `${task.id}.yaml`)
    await writeFile(filePath, stringifyYaml(task), 'utf-8')
  }

  async listAll(): Promise<Task[]> {
    if (!existsSync(this.tasksRoot)) return []
    const tasks: Task[] = []
    let entries: DirentString[]
    try {
      entries = (await readdir(this.tasksRoot, {
        withFileTypes: true,
        encoding: 'utf8',
      })) as DirentString[]
    } catch {
      return []
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = join(this.tasksRoot, entry.name)
      let files: string[]
      try {
        files = await readdir(dir)
      } catch {
        continue
      }
      for (const file of files) {
        if (!file.endsWith('.yaml')) continue
        const task = await this.read(join(dir, file))
        if (task) tasks.push(task)
      }
    }
    return tasks.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
  }

  async getById(id: string): Promise<Task | null> {
    if (!existsSync(this.tasksRoot)) return null
    let entries: DirentString[]
    try {
      entries = (await readdir(this.tasksRoot, {
        withFileTypes: true,
        encoding: 'utf8',
      })) as DirentString[]
    } catch {
      return null
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const filePath = join(this.tasksRoot, entry.name, `${id}.yaml`)
      if (existsSync(filePath)) return this.read(filePath)
    }
    return null
  }

  /** Absolute path of the YAML file backing this task id, or null if unknown. */
  async getFilePath(id: string): Promise<string | null> {
    if (!existsSync(this.tasksRoot)) return null
    let entries: DirentString[]
    try {
      entries = (await readdir(this.tasksRoot, {
        withFileTypes: true,
        encoding: 'utf8',
      })) as DirentString[]
    } catch {
      return null
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const filePath = join(this.tasksRoot, entry.name, `${id}.yaml`)
      if (existsSync(filePath)) return filePath
    }
    return null
  }

  async move(task: Task, newStatus: string): Promise<Task> {
    const oldDir = this.statusDir(task.status)
    const newDir = await this.ensureStatusDir(newStatus)
    const oldPath = join(oldDir, `${task.id}.yaml`)
    const newPath = join(newDir, `${task.id}.yaml`)
    const updated: Task = { ...task, status: newStatus as Task['status'] }
    if (newStatus === 'approved') {
      updated.approved_at = new Date().toISOString()
    }
    await writeFile(newPath, stringifyYaml(updated), 'utf-8')
    if (existsSync(oldPath) && oldPath !== newPath) await unlink(oldPath)
    return updated
  }

  async update(task: Task): Promise<void> {
    const dir = this.statusDir(task.status)
    const filePath = join(dir, `${task.id}.yaml`)
    await writeFile(filePath, stringifyYaml(task), 'utf-8')
  }

  async delete(id: string): Promise<void> {
    const filePath = await this.getFilePath(id)
    if (filePath) await unlink(filePath)
  }

  async listStatuses(): Promise<string[]> {
    if (!existsSync(this.tasksRoot)) return []
    try {
      const entries = await readdir(this.tasksRoot, { withFileTypes: true })
      return entries.filter((e) => e.isDirectory()).map((e) => DIR_TO_STATUS[e.name] ?? e.name)
    } catch {
      return []
    }
  }
}
