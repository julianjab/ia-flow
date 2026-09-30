import type { InboxItem } from '@ia-flow/shared'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import AssistantTaskList from '../AssistantTaskList.vue'

const task = (over: Partial<InboxItem>): InboxItem => ({
  ref: 'acme/api#7',
  project_id: 'core',
  title: 'Bloquear reasignación',
  url: 'https://github.com/acme/api/issues/7',
  group: 'need',
  kind: 'merge',
  labels: [],
  why: 'PR aprobado por el reviewer',
  since: '2026-09-30T10:00:00Z',
  actions: ['merge'],
  ...over,
})

describe('AssistantTaskList', () => {
  it('muestra cada tarea con su caso, ref, título y por qué', () => {
    const w = mount(AssistantTaskList, { props: { items: [task({})] } })
    const text = w.text()
    expect(text).toContain('Listo para mergear')
    expect(text).toContain('acme/api#7')
    expect(text).toContain('Bloquear reasignación')
    expect(text).toContain('PR aprobado por el reviewer')
  })

  it('tocar una tarea de la bandeja pide abrirla', async () => {
    const w = mount(AssistantTaskList, { props: { items: [task({})] } })
    await w.get('[data-test="open-acme/api#7"]').trigger('click')
    expect(w.emitted('open')).toEqual([['acme/api#7']])
  })

  it('una tarea sin pendientes no está en la bandeja: abre GitHub', () => {
    const w = mount(AssistantTaskList, {
      props: { items: [task({ group: 'idle', kind: 'idle', ref: 'acme/api#9' })] },
    })
    expect(w.find('button').exists()).toBe(false)
    expect(w.get('a').attributes('href')).toBe('https://github.com/acme/api/issues/7')
  })
})
