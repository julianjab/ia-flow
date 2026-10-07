import type { EventLogEntry } from '@ia-flow/shared'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/features/inbox/api', () => ({ explainTask: vi.fn() }))

import TaskEvents from '../TaskEvents.vue'

const event = (over: Partial<EventLogEntry>): EventLogEntry => ({
  id: 'e1',
  type: 'projects_v2_item.edited',
  occurred_at: '2026-09-30T11:57:14Z',
  task_ref: 'o/r#1',
  summary: { field: 'Working', pr: 3483, issue: 'o/r#1' },
  outcome: 'skipped',
  decisions: [
    {
      source_id: 'p',
      pipeline_id: 'refine',
      verdict: 'mismatch',
      reason:
        'no cumple: item.status eq "Refine" (vino "Review"); fieldName notIn ["Working"] (vino "Working")',
    },
    {
      source_id: 'p',
      pipeline_id: 'e2e',
      verdict: 'mismatch',
      reason: 'no cumple: item.labels contains "e2e-test"',
    },
  ],
  ...over,
})

describe('TaskEvents', () => {
  it('cada evento arranca colapsado: qué llegó, cómo terminó y cuántas pipelines no aplicaron', () => {
    const w = mount(TaskEvents, { props: { taskRef: 'o/r#1', events: [event({})] } })
    const item = w.get('details.er')
    expect(item.attributes('open')).toBeUndefined()
    const row = w.get('summary').text()
    expect(row).toContain('projects_v2_item.edited')
    expect(row).toContain('2 no aplicaron')
    // `issue` es la propia tarea: no se repite.
    expect(row).toContain('field=Working · pr=3483')
    expect(row).not.toContain('issue=')
  })

  it('abierto, cada condición que cortó va en su renglón', () => {
    const w = mount(TaskEvents, { props: { taskRef: 'o/r#1', events: [event({})] } })
    expect(w.findAll('.er__reason').map((r) => r.text())).toEqual([
      'no cumple: item.status eq "Refine" (vino "Review")',
      'fieldName notIn ["Working"] (vino "Working")',
      'no cumple: item.labels contains "e2e-test"',
    ])
  })

  it('lo que corrió se nombra, y un evento con error arranca abierto', () => {
    const w = mount(TaskEvents, {
      props: {
        taskRef: 'o/r#1',
        events: [
          event({
            outcome: 'error',
            error: 'se cayó',
            decisions: [{ source_id: 'p', pipeline_id: 'review', verdict: 'ran' }],
          }),
        ],
      },
    })
    expect(w.get('summary').text()).toContain('✓ corrió review')
    expect(w.get('details.er').attributes('open')).toBeDefined()
    expect(w.text()).toContain('✕ se cayó')
  })

  it('un evento que arrancó una ejecución de la lista la abre, sin plegar ni desplegar el evento', async () => {
    const w = mount(TaskEvents, {
      props: {
        taskRef: 'o/r#1',
        events: [
          event({ id: 'e1', execution_id: 'exec-0001' }),
          event({ id: 'e2', execution_id: 'exec-gone' }),
          event({ id: 'e3' }),
        ],
        executionIds: ['exec-0001'],
      },
    })
    const links = w.findAll('[data-test^="open-execution-"]')
    expect(links.map((l) => l.attributes('data-test'))).toEqual(['open-execution-exec-0001'])

    await links[0]?.trigger('click')
    expect(w.emitted('open-execution')).toEqual([['exec-0001']])
    expect(w.get('details.er').attributes('open')).toBeUndefined()
  })
})
