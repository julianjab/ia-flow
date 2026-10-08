import { describe, expect, it } from 'vitest'
import { sectionsOf } from '@/features/inbox/state/sections'

const both = { feed: true, pipeline: true }
const noFeed = { feed: false, pipeline: true }

describe('sectionsOf — cada sección según el pedido que la alimenta', () => {
  it('antes de pedir nada, todo carga', () => {
    expect(sectionsOf({ decisions: 'idle', runner: 'idle', panels: noFeed })).toEqual({
      decisions: 'loading',
      epics: 'loading',
      hygiene: 'loading',
      pipeline: 'loading',
      feed: 'loading',
    })
  })

  it('el feed del runner pinta aunque las decisiones sigan cargando', () => {
    const s = sectionsOf({ decisions: 'loading', runner: 'ready', panels: noFeed })
    expect(s.feed).toBe('ready')
    expect(s.decisions).toBe('loading')
    expect(s.pipeline).toBe('loading')
  })

  it('las decisiones, las épicas y el pipeline pintan aunque el feed del runner siga cargando', () => {
    const s = sectionsOf({ decisions: 'ready', runner: 'loading', panels: noFeed })
    expect(s).toMatchObject({
      decisions: 'ready',
      epics: 'ready',
      pipeline: 'ready',
      feed: 'loading',
    })
  })

  it('con el feed en el dashboard, el feed llega con las decisiones', () => {
    expect(sectionsOf({ decisions: 'loading', runner: 'idle', panels: both }).feed).toBe('loading')
    expect(sectionsOf({ decisions: 'ready', runner: 'idle', panels: both }).feed).toBe('ready')
  })

  it('si el dashboard apaga la capacidad, el pipeline espera la del runner', () => {
    const off = { feed: true, pipeline: false }
    expect(sectionsOf({ decisions: 'ready', runner: 'loading', panels: off }).pipeline).toBe(
      'loading',
    )
    // Si la del runner falla, se cuentan las tarjetas: el pipeline pinta igual.
    expect(sectionsOf({ decisions: 'ready', runner: 'error', panels: off }).pipeline).toBe('ready')
  })

  it('un error es de su sección: el del runner no tumba las decisiones, ni al revés', () => {
    expect(sectionsOf({ decisions: 'ready', runner: 'error', panels: noFeed })).toMatchObject({
      decisions: 'ready',
      feed: 'error',
    })
    expect(sectionsOf({ decisions: 'error', runner: 'ready', panels: noFeed })).toMatchObject({
      decisions: 'error',
      epics: 'error',
      feed: 'ready',
    })
  })

  it('un runner viejo (sin dashboard): el feed sale de /api/inbox; sin pedirlo, no hay feed', () => {
    expect(sectionsOf({ decisions: 'ready', runner: 'ready', panels: null }).feed).toBe('ready')
    expect(sectionsOf({ decisions: 'ready', runner: 'idle', panels: null }).feed).toBe('none')
  })
})
