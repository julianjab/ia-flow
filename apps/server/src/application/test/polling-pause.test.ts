import { beforeEach, describe, expect, it } from 'bun:test'
import { isProjectPaused, listPausedProjects, resumeProject } from '@ia-flow/issue-sources'
import type { Project } from '@ia-flow/shared'
import type { IProjectRepository, ProjectInput } from '../../domain/ports/IProjectRepository.js'
import { hydratePausedProjects, setProjectPaused } from '../polling-pause.js'

// Fake repo escrito a mano — el caso de uso no debe necesitar la DB.
class FakeProjectRepo implements IProjectRepository {
  constructor(private rows: Project[] = []) {}
  getDefaultId(): string {
    return this.rows[0]?.id ?? ''
  }
  list(): Project[] {
    return this.rows
  }
  get(id: string): Project | null {
    return this.rows.find((p) => p.id === id) ?? null
  }
  upsert(input: ProjectInput): Project {
    const next = { ...(this.get(input.id) ?? {}), ...input } as Project
    this.rows = [...this.rows.filter((p) => p.id !== input.id), next]
    return next
  }
  archive(): void {}
  deleteCascade(): void {}
}

const project = (id: string, settings: Record<string, unknown> = {}): Project =>
  ({ id, name: id, settings }) as Project

beforeEach(() => {
  for (const id of listPausedProjects()) resumeProject(id)
})

describe('hydratePausedProjects', () => {
  it('re-arma el gate en memoria desde settings.pollingPaused', () => {
    const repo = new FakeProjectRepo([
      project('paused-one', { pollingPaused: true }),
      project('active-one', { pollingPaused: false }),
      project('no-setting'),
    ])

    expect(hydratePausedProjects(repo)).toEqual(['paused-one'])
    expect(isProjectPaused('paused-one')).toBe(true)
    expect(isProjectPaused('active-one')).toBe(false)
    expect(isProjectPaused('no-setting')).toBe(false)
  })
})

describe('setProjectPaused', () => {
  it('pausa y persiste el flag', () => {
    const repo = new FakeProjectRepo([project('p1', { daemonMode: 'polling' })])

    expect(setProjectPaused(repo, 'p1', true)).toBe(true)
    expect(isProjectPaused('p1')).toBe(true)
    // No pisa el resto de settings.
    expect(repo.get('p1')?.settings).toEqual({ daemonMode: 'polling', pollingPaused: true })
  })

  it('reanuda y persiste el flag en false', () => {
    const repo = new FakeProjectRepo([project('p1', { pollingPaused: true })])
    hydratePausedProjects(repo)

    expect(setProjectPaused(repo, 'p1', false)).toBe(true)
    expect(isProjectPaused('p1')).toBe(false)
    expect(repo.get('p1')?.settings).toEqual({ pollingPaused: false })
  })

  it('devuelve false para un proyecto desconocido y no toca el gate', () => {
    const repo = new FakeProjectRepo([])

    expect(setProjectPaused(repo, 'nope', true)).toBe(false)
    expect(isProjectPaused('nope')).toBe(false)
  })
})
