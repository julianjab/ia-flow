import { describe, expect, it } from 'vitest'
import { createEvent } from '../../events/DomainEvent.js'
import { Inbox } from '../Inbox.js'

describe('Inbox', () => {
  it('hands out each delivered message once, and what nobody read once', () => {
    const inbox = new Inbox()
    const first = createEvent('comment', { n: 1 })
    const late = createEvent('comment', { n: 2 })

    inbox.deliver('uno', first)
    expect(inbox.drain()).toEqual(['uno'])
    expect(inbox.drain()).toEqual([])

    inbox.deliver('dos', late)
    expect(inbox.takeUnread()).toEqual([late])
    expect(inbox.takeUnread()).toEqual([])
  })

  it('remembers what nobody accepted until it is taken', () => {
    const inbox = new Inbox()
    const ci = createEvent('ci', {})
    inbox.miss(ci)
    expect(inbox.takeMissed()).toEqual([ci])
    expect(inbox.takeMissed()).toEqual([])
  })

  it('a notice is read like a message, but it is not an event to hand back', () => {
    const inbox = new Inbox()
    inbox.notify('te interrumpieron')
    expect(inbox.drain()).toEqual(['te interrumpieron'])

    const comment = createEvent('comment', {})
    inbox.notify('otra vez')
    inbox.deliver('comentario', comment)
    expect(inbox.takeUnread()).toEqual([comment])
  })

  describe('con varios lectores (un grupo `parallel`)', () => {
    const reviewer = { id: 'reviewer' }
    const e2e = { id: 'e2e' }

    it('cada lector lee sólo lo suyo, y lo sin destinatario lo lee cualquiera', () => {
      const inbox = new Inbox()
      inbox.deliver('para el reviewer', createEvent('comment', {}), [reviewer])
      inbox.notify('aviso para el e2e', [e2e])
      inbox.notify('aviso para todos')

      expect(inbox.drain(reviewer)).toEqual(['para el reviewer', 'aviso para todos'])
      expect(inbox.drain(reviewer)).toEqual([])
      expect(inbox.drain(e2e)).toEqual(['aviso para el e2e', 'aviso para todos'])
    })

    it('una entrega para dos: lo que uno leyó lo sigue viendo el otro, y no vuelve', () => {
      const inbox = new Inbox()
      const comment = createEvent('comment', {})
      inbox.deliver('uno', comment, [reviewer, e2e])

      expect(inbox.drain(reviewer)).toEqual(['uno'])
      expect(inbox.drain(e2e)).toEqual(['uno'])
      expect(inbox.takeUnread()).toEqual([])
    })

    it('una entrega que ninguno leyó vuelve una sola vez, aunque fuera para dos', () => {
      const inbox = new Inbox()
      const comment = createEvent('comment', {})
      inbox.deliver('tarde', comment, [reviewer, e2e])
      expect(inbox.takeUnread()).toEqual([comment])
      expect(inbox.takeUnread()).toEqual([])
    })

    it('el mismo evento entregado dos veces son dos entregas', () => {
      const inbox = new Inbox()
      const comment = createEvent('comment', {})
      inbox.deliver('primero', comment, [reviewer])
      expect(inbox.drain(reviewer)).toEqual(['primero'])
      inbox.deliver('otra vez', comment, [reviewer])
      expect(inbox.takeUnread()).toEqual([comment])
    })
  })
})
