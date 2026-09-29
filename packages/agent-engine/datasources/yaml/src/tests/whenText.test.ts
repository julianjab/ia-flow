import {
  createEvent,
  Engine,
  EventBus,
  ProviderRegistry,
  type TextClassifier,
  type WhenText,
} from '@ia-flow/agent-engine'
import type { Catalogs } from '@ia-flow/agent-engine-definitions'
import { describe, expect, it, vi } from 'vitest'
import { sourceDir, yamlSource } from './fixtures.js'

/** Dice que sí a los criterios que empiezan con `yes`, y guarda qué le preguntaron. */
function recordingClassifier() {
  const asked: WhenText[] = []
  const classifier: TextClassifier = {
    classify: async ({ whenText }) => {
      asked.push(whenText)
      return { matches: whenText.text.startsWith('yes'), reason: 'porque sí' }
    },
  }
  return { asked, classifier }
}

const SOURCE = `
id: flow
systemPrompts:
  - id: criterio-pr
    text: Un cambio es algo que alguien tiene que hacer en el código o el PRD.
`

function mount(files: Record<string, string>, catalogs: Catalogs = {}) {
  const { asked, classifier } = recordingClassifier()
  const ran = vi.fn()
  const source = yamlSource({
    dir: sourceDir({ 'source.yaml': SOURCE, ...files }),
    catalogs: {
      functions: { ran: (ctx) => ran(ctx.pipelineId) },
      systemPrompts: { resolve: (id) => (id === 'del-catalogo' ? 'Del catálogo.' : undefined) },
      ...catalogs,
    },
  })
  const engine = new Engine({ bus: new EventBus(), pipelines: source, textClassifier: classifier })
  return { engine, asked, ran }
}

describe('whenText in YAML', () => {
  it('a pipeline gate with system prompts by id — the source ones and the catalog ones — and inline', async () => {
    const { engine, asked, ran } = mount({
      'pipelines/yes.yaml': `
id: yes
on: [a]
whenText:
  text: yes, pide un cambio
  systemPrompts: [criterio-pr, del-catalogo, { text: Inline. }]
do:
  - { function: ran }
`,
      'pipelines/no.yaml': `
id: no
on: [a]
whenText: no aplica
do:
  - { function: ran }
`,
    })

    await engine.dispatch(createEvent('a', {}))

    expect(ran.mock.calls.map(([pipeline]) => pipeline)).toEqual(['yes'])
    expect(asked).toContainEqual({
      text: 'yes, pide un cambio',
      systemPrompts: [
        'Un cambio es algo que alguien tiene que hacer en el código o el PRD.',
        'Del catálogo.',
        'Inline.',
      ],
    })
    expect(asked).toContainEqual({ text: 'no aplica' })
  })

  it('on a step and on an agent step (which wins over the agent’s own)', async () => {
    const providers = new ProviderRegistry().register({
      id: 'fake',
      run: async (ctx) => {
        await ctx.tools.find((tool) => tool.name === 'submit_done')?.handler({})
        return { outcome: 'done' }
      },
    })
    const { engine, asked, ran } = mount(
      {
        'agents/writer.yaml': `
id: writer
provider: fake
prompt: Escribí.
whenText: no, el del agente
`,
        'pipelines/p.yaml': `
id: p
on: [a]
do:
  - { function: ran, whenText: no corre }
  - { agent: writer, whenText: 'yes, el del paso' }
  - { function: ran, id: after, whenText: 'yes, otro' }
`,
      },
      { providers },
    )

    await engine.dispatch(createEvent('a', {}))

    expect(asked.map((w) => w.text)).toEqual(['no corre', 'yes, el del paso', 'yes, otro'])
    expect(ran).toHaveBeenCalledTimes(1)
  })

  it('a system prompt id nobody declares breaks the load', () => {
    expect(() =>
      mount({
        'pipelines/p.yaml': `
id: p
on: [a]
whenText: { text: x, systemPrompts: [no-existe] }
do:
  - { function: ran }
`,
      }),
    ).toThrow(
      /pipelines\/p\.yaml: whenText.*no hay un system prompt "no-existe" — la fuente declara: criterio-pr/,
    )
  })
})
