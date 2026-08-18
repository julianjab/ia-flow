import { describe, expect, it, mock } from 'bun:test'
import type { Project } from '@ia-flow/shared'
import type { ProjectSource } from '../contract.js'
import { createSourceFactory } from '../source-factory.js'

function fakeSource(kind: string): ProjectSource {
  return {
    kind,
    getStatuses: async () => [],
    getItems: async () => [],
  } as unknown as ProjectSource
}

function project(id: string, source?: Project['source']): Project {
  return { id, name: id, source }
}

describe('createSourceFactory', () => {
  it('dispatches to the builder registered for a project kind', () => {
    const factory = createSourceFactory()
    const build = mock(() => fakeSource('github'))
    factory.add('github', build)

    const source = factory.get(project('p1', { kind: 'github', config: { url: 'x' } }))

    expect(source.kind).toBe('github')
    expect(build).toHaveBeenCalledTimes(1)
  })

  it('throws for a kind with no registered builder', () => {
    const factory = createSourceFactory()
    expect(() => factory.get(project('p1', { kind: 'linear' }))).toThrow(
      /Unknown project source kind/,
    )
  })

  it('treats a project with no source as local', () => {
    const factory = createSourceFactory()
    const build = mock(() => fakeSource('local'))
    factory.add('local', build)

    factory.get(project('p1'))

    expect(build).toHaveBeenCalledWith(expect.anything(), {})
  })

  it('caches one instance per (kind, config) — same config, same instance', () => {
    const factory = createSourceFactory()
    factory.add('github', () => fakeSource('github'))

    const a = factory.get(project('p1', { kind: 'github', config: { url: 'same' } }))
    const b = factory.get(project('p2', { kind: 'github', config: { url: 'same' } }))

    expect(a).toBe(b)
  })

  it('builds a separate instance per distinct config', () => {
    const factory = createSourceFactory()
    const build = mock((_p: Project, cfg: Record<string, unknown>) => fakeSource(String(cfg.url)))
    factory.add('github', build)

    const a = factory.get(project('p1', { kind: 'github', config: { url: 'a' } }))
    const b = factory.get(project('p2', { kind: 'github', config: { url: 'b' } }))

    expect(a).not.toBe(b)
    expect(build).toHaveBeenCalledTimes(2)
  })

  it('invalidate drops the cached instance so the next get() rebuilds', () => {
    const factory = createSourceFactory()
    const build = mock(() => fakeSource('github'))
    factory.add('github', build)
    const p = project('p1', { kind: 'github', config: { url: 'x' } })

    const first = factory.get(p)
    factory.invalidate(p)
    const second = factory.get(p)

    expect(build).toHaveBeenCalledTimes(2)
    expect(first).not.toBe(second)
  })
})
