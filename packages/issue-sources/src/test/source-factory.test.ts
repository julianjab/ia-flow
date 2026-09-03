import { describe, expect, it, mock } from 'bun:test'
import type { Project } from '@ia-flow/shared'
import type { ITaskRepository, ProjectSource } from '../contract.js'
import { createDefaultSourceFactory, createSourceFactory } from '../source-factory.js'

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

  it('listKinds reports every registered kind, in registration order', () => {
    const factory = createSourceFactory()
    factory.add('github', () => fakeSource('github'))
    factory.add('local', () => fakeSource('local'))

    expect(factory.listKinds()).toEqual(['github', 'local'])
  })

  it('listKinds is empty for a factory with nothing registered', () => {
    expect(createSourceFactory().listKinds()).toEqual([])
  })
})

describe('createDefaultSourceFactory', () => {
  const fakeTaskRepo: ITaskRepository = {
    root: () => '/tmp/fake',
    read: async () => null,
    save: async () => {},
    listAll: async () => [],
    getById: async () => null,
    move: async (task) => task,
    update: async () => {},
    delete: async () => {},
    listStatuses: async () => [],
  }

  it('lists every kind this package ships support for — sin los alias deprecados', () => {
    const factory = createDefaultSourceFactory({ taskRepo: fakeTaskRepo })
    expect(factory.listKinds()).toEqual(['github-projects', 'local', 'github-issues'])
  })

  it("sigue construyendo el kind viejo 'github' — las filas ya persistidas no se rompen", () => {
    const factory = createDefaultSourceFactory({ taskRepo: fakeTaskRepo })
    const source = factory.get(
      project('p1', { kind: 'github', config: { url: 'https://github.com/orgs/x/projects/1' } }),
    )
    expect(source.kind).toBe('github-projects')
  })

  it('el alias y el kind canónico comparten instancia para la misma config', () => {
    const factory = createDefaultSourceFactory({ taskRepo: fakeTaskRepo })
    const config = { url: 'https://github.com/orgs/x/projects/1' }
    const viejo = factory.get(project('p1', { kind: 'github', config }))
    const nuevo = factory.get(project('p2', { kind: 'github-projects', config }))
    // Misma instancia = mismo cache @memoize = una sola tanda de llamadas a GraphQL.
    expect(nuevo).toBe(viejo)
  })

  it('builds a GitHubIssueSource for the github-issues kind', () => {
    const factory = createDefaultSourceFactory({ taskRepo: fakeTaskRepo })
    const source = factory.get(
      project('p1', {
        kind: 'github-issues',
        config: { owner: 'la-haus', repo: 'ia-flow', anchorLabel: 'ia-flow' },
      }),
    )
    expect(source.kind).toBe('github-issues')
  })

  it('throws when github-issues config is missing a required field', () => {
    const factory = createDefaultSourceFactory({ taskRepo: fakeTaskRepo })
    expect(() =>
      factory.get(project('p1', { kind: 'github-issues', config: { owner: 'la-haus' } })),
    ).toThrow(/config\.repo/)
  })

  it('builds a GitHubIssueSource without an anchorLabel', () => {
    // anchorLabel es opcional — sin ella el source vigila todo issue abierto.
    const factory = createDefaultSourceFactory({ taskRepo: fakeTaskRepo })
    const source = factory.get(
      project('p1', { kind: 'github-issues', config: { owner: 'julianjab', repo: 'accountant' } }),
    )
    expect(source.kind).toBe('github-issues')
  })

  it('throws when github-issues anchorLabel is present but not a string', () => {
    const factory = createDefaultSourceFactory({ taskRepo: fakeTaskRepo })
    expect(() =>
      factory.get(
        project('p1', {
          kind: 'github-issues',
          config: { owner: 'la-haus', repo: 'ia-flow', anchorLabel: 42 },
        }),
      ),
    ).toThrow(/anchorLabel/)
  })

  it('builds a GithubHybridSource for the github-hybrid kind (alias legacy)', () => {
    const factory = createDefaultSourceFactory({ taskRepo: fakeTaskRepo })
    const source = factory.get(
      project('p1', {
        kind: 'github-hybrid',
        config: {
          owner: 'la-haus',
          repo: 'ia-flow',
          url: 'https://github.com/orgs/la-haus/projects/1',
        },
      }),
    )
    expect(source.kind).toBe('github-hybrid')
  })

  it('builds a GithubHybridSource for github-projects cuando la config trae owner+repo', () => {
    const factory = createDefaultSourceFactory({ taskRepo: fakeTaskRepo })
    const source = factory.get(
      project('p1', {
        kind: 'github-projects',
        config: {
          owner: 'la-haus',
          repo: 'ia-flow',
          url: 'https://github.com/orgs/la-haus/projects/1',
        },
      }),
    )
    expect(source.kind).toBe('github-hybrid')
  })

  it('github-hybrid sin la mitad de issues cae a un GitHubProjectSource liso — ya no es un error', () => {
    const factory = createDefaultSourceFactory({ taskRepo: fakeTaskRepo })
    const source = factory.get(
      project('p1', {
        kind: 'github-hybrid',
        config: { url: 'https://github.com/orgs/la-haus/projects/1' },
      }),
    )
    expect(source.kind).toBe('github-projects')
  })

  it('throws when github-hybrid is missing the board url', () => {
    const factory = createDefaultSourceFactory({ taskRepo: fakeTaskRepo })
    expect(() =>
      factory.get(
        project('p1', {
          kind: 'github-hybrid',
          config: { owner: 'la-haus', repo: 'ia-flow' },
        }),
      ),
    ).toThrow(/config\.url/)
  })
})

describe('validate', () => {
  it('surfaces the builder error for an incomplete config', () => {
    const factory = createDefaultSourceFactory({ taskRepo: {} as ITaskRepository })
    expect(() => factory.validate(project('p1', { kind: 'github', config: {} }))).toThrow(
      /requires config.url/,
    )
  })

  it('does not cache the instance it built — an API border validating a row that never lands must not leave a live source behind', () => {
    const factory = createSourceFactory()
    const build = mock(() => fakeSource('github'))
    factory.add('github', build)
    const p = project('p1', { kind: 'github', config: { url: 'x' } })

    factory.validate(p)
    factory.get(p)

    expect(build).toHaveBeenCalledTimes(2)
  })

  it('passes for a config the builder accepts', () => {
    const factory = createDefaultSourceFactory({ taskRepo: {} as ITaskRepository })
    expect(() =>
      factory.validate(project('p1', { kind: 'github-issues', config: { owner: 'o', repo: 'r' } })),
    ).not.toThrow()
  })
})
