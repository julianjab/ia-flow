import { describe, expect, it } from 'bun:test'
import { createEvent, EventBus, PromptRenderer } from '@ia-flow/agent-engine'
import type { DefinitionSource, SourceDocs } from '@ia-flow/agent-engine-definitions'
import { taskPayload } from '../intake/task.js'
import { withRepoPrompts, withRepoPromptsSection } from './withRepoPrompts.js'

/** Un datasource en memoria con un agente por prompt. */
const memory = (prompts: Record<string, string>): DefinitionSource => ({
  version: () => '7',
  read: (): SourceDocs => ({
    id: 'p',
    source: { path: 'mem:p', doc: {} },
    agents: Object.entries(prompts).map(([id, prompt]) => ({
      path: `mem:p/${id}`,
      doc: { id, prompt } as never,
    })),
    pipelines: [],
  }),
})

/** El prompt de `prompt`, renderizado contra el payload de una task en `repo`. */
function rendered(prompt: string, repo: string): string {
  const { payload } = taskPayload({
    emit: 'issue.status_changed',
    owner: 'la-haus',
    repo,
    number: 1,
    card: { itemId: 'PVTI_1', type: 'technical', status: 'Build' },
    issue: { title: 'T', html_url: `https://github.com/la-haus/${repo}/issues/1`, labels: [] },
    projectId: 'p',
    branch: 'feat/t',
    repos: '',
    repoPrompts: [
      { name: 'api', githubOwner: 'la-haus', githubRepo: 'api', prompt: 'Notas de A.' },
      { name: 'web', githubOwner: 'la-haus', githubRepo: 'web', prompt: 'Notas de B.' },
    ],
  })
  const ctx = {
    event: createEvent('issue.status_changed', payload),
    steps: {},
    bus: new EventBus(),
    pipelineId: 'build',
  }
  return new PromptRenderer().render(withRepoPromptsSection(prompt), ctx, {}, {}, []).prompt
}

describe('withRepoPrompts', () => {
  it('suma {{task.repo_prompts}} al final del prompt de cada agente, sin tocar la versión', () => {
    const source = withRepoPrompts(memory({ a: 'Hacé la task.\n', b: 'Revisá.' }))
    expect(source.version()).toBe('7')
    expect(source.read().agents.map((a) => a.doc.prompt)).toEqual([
      'Hacé la task.\n\n{{task.repo_prompts}}',
      'Revisá.\n\n{{task.repo_prompts}}',
    ])
  })

  it('un prompt que ya nombra la variable decide dónde van: no se suma otra vez', () => {
    const prompt = 'Antes de todo:\n{{ task.repo_prompts }}\n\nHacé la task.'
    expect(withRepoPromptsSection(prompt)).toBe(prompt)
  })

  it('al correr, una task en A ve las notas de A y no las de B', () => {
    const prompt = rendered('Implementá la task.', 'api')
    expect(prompt).toBe('Implementá la task.\n\n## Notas del repo `api`\n\nNotas de A.')
    expect(prompt).not.toContain('Notas de B.')
  })

  it('una task en un repo sin notas no ve nada (ni la variable literal)', () => {
    const prompt = rendered('Implementá la task.', 'otro')
    expect(prompt).not.toContain('{{')
    expect(prompt).not.toContain('Notas del repo')
  })
})
