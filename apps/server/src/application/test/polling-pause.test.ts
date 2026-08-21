import { describe, expect, it } from 'bun:test'
import type { Project } from '@ia-flow/shared'
import type { IPollingGate } from '../../domain/ports/IPollingGate.js'
import type { IProjectRepository, ProjectInput } from '../../domain/ports/IProjectRepository.js'
import { PollingPauseService } from '../polling-pause.js'

// Ports falsos escritos a mano — el servicio no debe necesitar ni la DB ni el
// Set global de @ia-flow/issue-sources.
class FakeProjectRepo implements IProjectRepository {
  constructor(private rows: Project[] = []) {}
  getDefaultId(): string {
    return this.rows[0]?.id ?? ''
  }
  list(includeArchived = false): Project[] {
    return includeArchived ? this.rows : this.rows.filter((p) => p.archivedAt == null)
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

// Espeja YamlProjectRepository, que es de sólo lectura.
class ReadOnlyProjectRepo extends FakeProjectRepo {
  override upsert(): Project {
    throw new Error('YamlProjectRepository es de sólo lectura: upsert')
  }
}

class FakeGate implements IPollingGate {
  readonly paused = new Set<string>()
  pause(id: string): void {
    this.paused.add(id)
  }
  resume(id: string): void {
    this.paused.delete(id)
  }
  isPaused(id: string): boolean {
    return this.paused.has(id)
  }
  listPaused(): string[] {
    return [...this.paused]
  }
}

const project = (id: string, settings: Record<string, unknown> = {}): Project =>
  ({ id, name: id, settings }) as Project

const build = (rows: Project[], repo: FakeProjectRepo = new FakeProjectRepo(rows)) => {
  const gate = new FakeGate()
  return { gate, repo, service: new PollingPauseService(repo, gate) }
}

describe('PollingPauseService.hydrate', () => {
  it('re-arma el gate desde settings.pollingPaused', () => {
    const { gate, service } = build([
      project('paused-one', { pollingPaused: true }),
      project('active-one', { pollingPaused: false }),
      project('no-setting'),
    ])

    expect(service.hydrate()).toEqual(['paused-one'])
    expect(gate.listPaused()).toEqual(['paused-one'])
  })

  it('ignora proyectos archivados — no se pollean', () => {
    const { gate, service } = build([
      { ...project('archived', { pollingPaused: true }), archivedAt: '2026-01-01T00:00:00Z' },
    ])

    expect(service.hydrate()).toEqual([])
    expect(gate.listPaused()).toEqual([])
  })
})

describe('PollingPauseService.setPaused', () => {
  it('pausa y persiste el flag sin pisar el resto de settings', () => {
    const { repo, service } = build([project('p1', { daemonMode: 'polling' })])

    expect(service.setPaused('p1', true)).toEqual({ found: true, persisted: true })
    expect(service.isPaused('p1')).toBe(true)
    expect(repo.get('p1')?.settings).toEqual({ daemonMode: 'polling', pollingPaused: true })
  })

  it('reanuda y persiste el flag en false', () => {
    const { repo, service } = build([project('p1', { pollingPaused: true })])
    service.hydrate()

    expect(service.setPaused('p1', false)).toEqual({ found: true, persisted: true })
    expect(service.isPaused('p1')).toBe(false)
    expect(repo.get('p1')?.settings).toEqual({ pollingPaused: false })
  })

  it('con repo de sólo lectura pausa igual pero reporta persisted:false', () => {
    const repo = new ReadOnlyProjectRepo([project('p1')])
    const { service } = build([], repo)

    expect(service.setPaused('p1', true)).toEqual({ found: true, persisted: false })
    expect(service.isPaused('p1')).toBe(true)
    expect(repo.get('p1')?.settings).toEqual({})
  })

  it('devuelve found:false para un proyecto desconocido y no toca el gate', () => {
    const { gate, service } = build([])

    expect(service.setPaused('nope', true)).toEqual({ found: false, persisted: false })
    expect(gate.listPaused()).toEqual([])
  })
})
