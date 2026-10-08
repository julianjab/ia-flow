import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import EpicsPanel from '@/features/inbox/pipeline/EpicsPanel.vue'
import type { EpicLine } from '@/features/inbox/queue/epics'

const line = (over: Partial<EpicLine> = {}): EpicLine => ({
  ref: 'la-haus/subscriptions#1100',
  title: 'Calidad de leads',
  url: 'https://github.com/la-haus/subscriptions/issues/1100',
  done: 2,
  total: 6,
  pct: 33,
  neck: '#1179 espera tu respuesta',
  blockedAt: 'la-haus/subscriptions#1179',
  ...over,
})

describe('EpicsPanel', () => {
  it('cada épica: nombre con link al issue, done/total, la barra decorativa y qué la traba', () => {
    const w = mount(EpicsPanel, {
      props: { epics: [line(), line({ ref: 'x/y#2', title: 'Pagos', pct: 25 })] },
    })
    const items = w.findAll('li')
    expect(items).toHaveLength(2)
    const link = items[0]!.get('a')
    expect(link.text()).toBe('Calidad de leads')
    expect(link.attributes('href')).toBe('https://github.com/la-haus/subscriptions/issues/1100')
    expect(link.attributes('target')).toBe('_blank')
    expect(link.attributes('rel')).toContain('noopener')
    // `.link`: el hover no es el video inverso global (que dejaba un bloque verde sin texto), y
    // el título completo va en el `title` porque el nombre se recorta a dos líneas.
    expect(link.classes()).toContain('link')
    expect(link.attributes('title')).toBe('Calidad de leads')
    expect(items[0]!.get('.mono').text()).toBe('2/6')
    const bar = items[0]!.get('[aria-hidden="true"]')
    expect(bar.get('div').attributes('style')).toContain('width: 33%')
    expect(items[0]!.get('[data-test="epic-neck"]').text()).toBe('#1179 espera tu respuesta')
    expect(items[1]!.text()).toContain('Pagos')
  })

  it('sin link si la épica no tiene url', () => {
    const { url: _url, ...noUrl } = line()
    const w = mount(EpicsPanel, { props: { epics: [noUrl] } })
    expect(w.find('a').exists()).toBe(false)
    expect(w.text()).toContain('Calidad de leads')
  })

  it('plegada: un <details> cerrado «Épicas» con cuántas están trabadas en vos', () => {
    const w = mount(EpicsPanel, {
      props: { epics: [line(), line({ ref: 'x/y#2' })], folded: true },
    })
    const details = w.get('details')
    expect(details.attributes('open')).toBeUndefined()
    expect(details.get('summary').text()).toContain('Épicas')
    expect(w.get('[data-test="epics-stuck"]').text()).toBe('2 trabadas en vos')
  })

  it('sin épicas no se dibuja', () => {
    expect(
      mount(EpicsPanel, { props: { epics: [] } })
        .find('[data-test="epics"]')
        .exists(),
    ).toBe(false)
    expect(
      mount(EpicsPanel, { props: { epics: [], folded: true } })
        .find('details')
        .exists(),
    ).toBe(false)
  })
})
