import { rmSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import {
  Action,
  createEvent,
  Engine,
  EventBus,
  InMemoryExecutionStore,
  ProviderRegistry,
  scopeExecutionKey,
} from '@ia-flow/agent-engine'
import { pipelineSourceContract } from '@ia-flow/agent-engine/testing'
import type { Catalogs } from '@ia-flow/agent-engine-definitions'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { YamlDefinitionSource } from '../YamlDefinitionSource.js'
import { CI_GATE, sourceDir, writeFiles, yamlSource } from './fixtures.js'

class Recorded extends Action {
  readonly description: string
  readonly input = z.strictObject({ label: z.string().optional() })

  constructor(
    id: string,
    private readonly ran: string[],
  ) {
    super({ id })
    this.description = id
  }

  execute(input: { label?: string }): string {
    this.ran.push(input.label ? `${this.id}:${input.label}` : this.id)
    return 'ok'
  }
}

function catalogs(ran: string[]): Catalogs {
  return {
    providers: new ProviderRegistry().register({
      id: 'done',
      run: async (ctx) => {
        ran.push(`implementer:${ctx.prompt}`)
        await ctx.tools.find((tool) => tool.name === 'submit_done')?.handler({})
        return { outcome: 'success' }
      },
    }),
    actions: { ensurePr: new Recorded('ensurePr', ran), addLabel: new Recorded('addLabel', ran) },
    functions: { review: (ctx) => ran.push(`review:${ctx.event.type}`) },
  }
}

pipelineSourceContract('YamlDefinitionSource + DefinitionPipelineSource', () => ({
  source: yamlSource({ dir: sourceDir(CI_GATE), catalogs: catalogs([]) }),
  matching: createEvent('build', { labels: [] }),
  expected: ['build'],
  nonMatching: createEvent('nobody-listens', {}),
}))

describe('YAML → pipelines', () => {
  it('drives the Engine through the CI gate: implementer, PR, pause, green, review', async () => {
    const ran: string[] = []
    const source = yamlSource({ dir: sourceDir(CI_GATE), catalogs: catalogs(ran) })
    const store = new InMemoryExecutionStore()
    const engine = new Engine({ bus: new EventBus(), pipelines: source, executions: store })
    const TASK = { issue: 7 }
    const key = scopeExecutionKey(createEvent('x', {}, { scope: TASK })) as string

    expect(source.id).toBe('flow')
    expect(
      await engine.dispatch(createEvent('build', { issue: 7, labels: [] }, { scope: TASK })),
    ).toBe('dispatched')
    expect(ran).toEqual(['implementer:Implementá el issue #7', 'ensurePr'])
    expect(store.current(key)?.pausedOn?.pauseId).toBe('wait-ci')

    expect(
      await engine.dispatch(
        createEvent('check_suite', { conclusion: 'success', labels: [] }, { scope: TASK }),
      ),
    ).toBe('resumed')
    expect(ran.at(-1)).toBe('review:check_suite')
  })

  it('the source onError applies to its agents', async () => {
    const ran: string[] = []
    const failing: Catalogs = {
      ...catalogs(ran),
      providers: new ProviderRegistry().register({
        id: 'done',
        run: async () => ({ outcome: 'error', summary: 'sin acceso' }),
      }),
    }
    const source = yamlSource({ dir: sourceDir(CI_GATE), catalogs: failing })
    await new Engine({ bus: new EventBus(), pipelines: source }).dispatch(
      createEvent('build', { issue: 1, labels: [] }),
    )
    expect(ran).toEqual(['addLabel:blocked'])
  })

  it('reloads when a file changes, and keeps the last good version when the new one is broken', () => {
    const dir = sourceDir(CI_GATE)
    const source = yamlSource({ dir, catalogs: catalogs([]) })
    const error = vi.spyOn(source.log, 'error').mockImplementation(() => {})
    const touch = (relative: string) => {
      const later = new Date(Date.now() + 5_000)
      utimesSync(join(dir, relative), later, later)
    }

    writeFiles(dir, {
      'pipelines/later.yaml':
        'id: later\non: [build]\nposition: 1\ndo:\n  - { function: review }\n',
    })
    expect(source.list().map((pipeline) => pipeline.id)).toEqual(['build', 'later'])

    writeFiles(dir, { 'pipelines/later.yaml': 'id: later\non: [build]\ndo: []\n' })
    touch('pipelines/later.yaml')
    expect(source.list().map((pipeline) => pipeline.id)).toEqual(['build', 'later'])
    expect(error).toHaveBeenCalledWith(expect.stringContaining('sigue la versión anterior'))

    rmSync(join(dir, 'pipelines/later.yaml'))
    expect(source.list().map((pipeline) => pipeline.id)).toEqual(['build'])
  })

  it('fails the first load saying which file and what is wrong', () => {
    const broken = (files: Record<string, string>) => () =>
      yamlSource({ dir: sourceDir(files), catalogs: catalogs([]) })

    expect(broken({ 'pipelines/a.yaml': 'id: a\non: [x]\ndo:\n  - { nope: 1 }\n' })).toThrow(
      /pipelines\/a\.yaml: do\[0\]: no es un paso conocido/,
    )
    expect(
      broken({ 'pipelines/a.yaml': 'id: a\non: [x]\ndo:\n  - { action: missing }\n' }),
    ).toThrow(
      /pipelines\/a\.yaml: do\[0\]: no hay una acción "missing" en el catálogo — hay: ensurePr, addLabel/,
    )
    expect(broken({ 'pipelines/a.yaml': 'id: a\ndo: []\n' })).toThrow(
      /pipelines\/a\.yaml: inválido/,
    )
    expect(broken({ 'pipelines/a.yaml': 'id: a\non: [x]\ndo:\n  - { agent: ghost }\n' })).toThrow(
      /no hay un agente "ghost" en agents\//,
    )
  })

  it('a ref reuses a step declared earlier in the same do', async () => {
    const ran: string[] = []
    const dir = sourceDir({
      'agents/triage.yaml': `
id: triage
provider: done
prompt: p
routes:
  done: { when: listo }
`,
      'pipelines/p.yaml': `
id: p
on: [e]
do:
  - { function: review, id: after }
  - { agent: triage }
routes:
  triage:
    routes:
      done: { to: [{ ref: after }] }
`,
    })
    const source = yamlSource({ dir, catalogs: catalogs(ran) })
    await new Engine({ bus: new EventBus(), pipelines: source }).dispatch(createEvent('e', {}))
    // `after` es destino de la salida: no corre en orden, sólo cuando triage elige `done`.
    expect(ran).toEqual(['implementer:p', 'review:e'])
  })

  it('builds one source per folder under a root', () => {
    const root = sourceDir({
      'b/source.yaml': 'id: b\n',
      'a/source.yaml': 'id: a\n',
      'not-a-source/readme.md': 'x',
    })
    expect(YamlDefinitionSource.fromRoot(root).map((source) => source.read().id)).toEqual([
      'a',
      'b',
    ])
  })

  it('a folder with only pipelines/ is a source too, named after the folder', () => {
    const root = sourceDir({ 'c/pipelines/p.yaml': 'id: p\non: [e]\ndo:\n  - { emit: x }\n' })
    expect(YamlDefinitionSource.fromRoot(root).map((source) => source.read().id)).toEqual(['c'])
  })

  it('takes its id from whoever mounts it, over the one in source.yaml', () => {
    const source = yamlSource({
      dir: sourceDir(CI_GATE),
      id: 'mounted',
      catalogs: catalogs([]),
    })
    expect(source.id).toBe('mounted')
  })
})

describe('YAML → pipelines: source.yaml', () => {
  it('does not take a when — which events a source gets is up to whoever mounts it', () => {
    const dir = sourceDir({
      ...CI_GATE,
      'source.yaml': 'id: flow\nwhen:\n  - { field: labels, op: notContains, value: blocked }\n',
    })
    expect(() => yamlSource({ dir })).toThrow(/source\.yaml: inválido/)
  })
})
