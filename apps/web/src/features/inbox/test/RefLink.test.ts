import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import RefLink from '@/features/inbox/decisions/RefLink.vue'

describe('RefLink', () => {
  it('es un `.link` a GitHub, en otra pestaña, con la ref corta en el title (se recorta si no entra)', () => {
    const short = 'la-haus/lh-seller-v2-frontend-con-nombre-largo#4281'
    const w = mount(RefLink, { props: { short, url: 'https://github.com/x/y/issues/4281' } })
    const a = w.get('a')
    expect(a.classes()).toEqual(expect.arrayContaining(['ref', 'link']))
    expect(a.attributes('title')).toBe(short)
    expect(a.attributes('href')).toBe('https://github.com/x/y/issues/4281')
    expect(a.attributes('target')).toBe('_blank')
    expect(a.attributes('aria-label')).toBe(`Abrir ${short} en GitHub`)
    expect(a.text()).toBe(`${short} ↗`)
  })
})
