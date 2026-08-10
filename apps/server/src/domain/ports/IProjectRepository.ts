import type { Project } from '@ia-flow/shared'

export type ProjectInput = Omit<Project, 'createdAt' | 'updatedAt' | 'archivedAt'>

export interface IProjectRepository {
  // Returns the oldest non-archived project id — used as fallback when a caller
  // doesn't specify projectId. Throws if the projects table is empty.
  getDefaultId(): string
  list(includeArchived?: boolean): Project[]
  get(id: string): Project | null
  upsert(input: ProjectInput): Project
  archive(id: string): void
  // Hard delete of a project and every row it owns (statuses, project-scoped
  // agents, project-scoped system prompts). Globals (project_id IS NULL) stay.
  deleteCascade(id: string): void
}
