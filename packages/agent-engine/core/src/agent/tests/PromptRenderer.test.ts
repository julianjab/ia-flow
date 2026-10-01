import { describe, expect, it } from 'vitest'
import { createEvent } from '../../events/DomainEvent.js'
import { EventBus } from '../../events/EventBus.js'
import type { PipelineExecutionContext } from '../../pipeline/Runnable.js'
import { PromptRenderer } from '../PromptRenderer.js'

const ctx: PipelineExecutionContext = {
  event: createEvent('issue.opened', { issue: { number: 7 } }),
  steps: { triage: { label: 'bug' } },
  bus: new EventBus(),
  pipelineId: 'p',
}

describe('PromptRenderer', () => {
  it('resolves placeholders against the payload, steps, variables and input — and leaves the rest', () => {
    const { prompt } = new PromptRenderer().render(
      '#{{issue.number}} {{steps.triage.label}} {{variables.repo}} {{input.focus}} {{nope}}',
      ctx,
      { focus: 'tests' },
      { repo: { value: 'ia-tools', full: 'la-haus/ia-tools' } },
      [],
    )
    expect(prompt).toBe('#7 bug la-haus/ia-tools tests {{nope}}')
  })

  it('takes system prompts inline or from the catalog, and drops the ones it cannot resolve', () => {
    const renderer = new PromptRenderer({
      resolve: (id) => (id === 'style' ? 'Escribí en español.' : undefined),
    })
    const { systemPrompts } = renderer.render('p', ctx, {}, {}, [
      { text: 'Sos un revisor.' },
      { id: 'style' },
      { id: 'missing' },
    ])
    expect(systemPrompts).toEqual(['Sos un revisor.', 'Escribí en español.'])
    expect(new PromptRenderer().render('p', ctx, {}, {}, [{ id: 'style' }]).systemPrompts).toEqual(
      [],
    )
  })
})
