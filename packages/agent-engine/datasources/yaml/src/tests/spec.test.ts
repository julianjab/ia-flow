import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DefinitionPipelineSource } from '@ia-flow/agent-engine-definitions'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { YamlDefinitionSource, type YamlSourceSpec } from '../YamlDefinitionSource.js'
import { sourceDir } from './fixtures.js'

const pipeline = (id: string) => `id: ${id}\non: [e]\ndo:\n  - { emit: x }\n`
const agent = (id: string) => `id: ${id}\nprovider: fake\nprompt: Hola.\n`

const ids = (source: YamlDefinitionSource) => {
  const docs = source.read()
  return {
    agents: docs.agents.map((a) => a.doc.id),
    pipelines: docs.pipelines.map((p) => p.doc.id),
  }
}

describe('YamlDefinitionSource with explicit entries', () => {
  const base = sourceDir({
    'agents/a.yaml': agent('a'),
    'agents/b.yaml': agent('b'),
    'flows/10-refine.yaml': pipeline('refine'),
    'flows/20-build.yaml': pipeline('build'),
    'flows/30-review.yaml': pipeline('review'),
    'intake.yaml': pipeline('intake'),
  })

  it('each list takes a directory, a file, a glob or an inline document — alone or in a list', () => {
    const source = new YamlDefinitionSource({
      id: 's',
      spec: {
        base,
        source: { systemPrompts: [{ text: 'Prefijo.' }] },
        agents: './agents',
        pipelines: [
          './intake.yaml',
          './flows/1*.yaml',
          { id: 'inline', on: ['e'], do: [{ emit: 'y' }] },
        ],
      } as YamlSourceSpec,
    })
    expect(ids(source)).toEqual({ agents: ['a', 'b'], pipelines: ['intake', 'refine', 'inline'] })
  })

  it('a glob matches only the file name, in name order', () => {
    const source = new YamlDefinitionSource({
      id: 's',
      spec: { base, pipelines: ['./flows/*0-*.yaml', './intake.yaml'] },
    })
    expect(ids(source).pipelines).toEqual(['refine', 'build', 'review', 'intake'])
    expect(() =>
      new YamlDefinitionSource({ id: 's', spec: { base, pipelines: './*/10-*.yaml' } }).read(),
    ).toThrow(/el glob sólo puede ir en el nombre del archivo/)
  })

  it('an inline document is validated and located where it was declared', () => {
    const source = new YamlDefinitionSource({
      id: 's',
      spec: { base, origin: 'runner.yaml', pipelines: [{ id: 'p', on: ['e'] }] },
    })
    expect(() => source.read()).toThrow(/runner\.yaml: pipelines\[0\]: inválido/)
  })

  it('a reference that does not exist breaks the read, naming it', () => {
    const source = new YamlDefinitionSource({ id: 's', spec: { base, agents: './nope' } })
    expect(() => source.read()).toThrow(/\.\/nope: no existe/)
  })

  it('a source path has to be exactly one file', () => {
    for (const ref of ['./agents', './nothing-*.yaml']) {
      expect(() =>
        new YamlDefinitionSource({ id: 's', spec: { base, source: ref } }).read(),
      ).toThrow(/source tiene que ser un único archivo/)
    }
  })

  it('vars are substituted in inline documents too', () => {
    const source = new YamlDefinitionSource({
      id: 's',
      vars: { event: 'e2' },
      spec: { base, pipelines: [{ id: 'p', on: ['{{vars.event}}'], do: [{ emit: 'x' }] }] },
    })
    expect(source.read().pipelines[0]?.doc.on).toEqual(['e2'])
  })
})

describe('YamlDefinitionSource over an index that changes', () => {
  it('re-reads the index when it changes, and the source reloads without restarting', async () => {
    const base = sourceDir({
      'index.yaml': 'pipelines: [./a.yaml]\n',
      'a.yaml': pipeline('a'),
      'b.yaml': pipeline('b'),
    })
    const index = join(base, 'index.yaml')
    const spec = (): YamlSourceSpec => ({
      base,
      origin: index,
      ...(parse(readFileSync(index, 'utf8')) as object),
    })
    const built = new DefinitionPipelineSource(
      new YamlDefinitionSource({ id: 's', spec, watch: [index] }),
    )
    expect(built.list().map((p) => p.id)).toEqual(['a'])

    await new Promise((resolve) => setTimeout(resolve, 20))
    writeFileSync(index, 'pipelines: [./a.yaml, ./b.yaml]\n')
    expect(built.list().map((p) => p.id)).toEqual(['a', 'b'])
  })
})
