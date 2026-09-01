import { RULE_TEMPLATES, recurringRuleWarning } from '@/features/rules/rule-templates'
import { describe, expect, it } from 'vitest'

const byKey = (k: string) => RULE_TEMPLATES.find((t) => t.key === k)!

describe('RULE_TEMPLATES', () => {
  // Una plantilla pre-llena la FORMA, no valores inventados: un `agentId` de
  // ejemplo que nadie eligió se guarda sin que nadie lo mire.
  it('deja vacíos los campos que sólo el operador puede elegir', () => {
    const t = byKey('status').build()
    expect(t.do?.[0]).toEqual({ action: 'agent', agentId: '' })
    expect((t.when as Array<{ value: string }>)[0].value).toBe('')
  })

  // "Una etapa, un agente" es la forma del pipeline por status. Sin
  // `exclusive`, dos reglas sobre el mismo status corren LAS DOS — el cambio de
  // semántica más fácil de no ver al venir del modelo viejo, donde
  // `selectAgent` corría sólo la primera.
  it('la plantilla de status nace exclusiva', () => {
    expect(byKey('status').build().exclusive).toBe(true)
  })

  it('la de PR escucha apertura y actualización', () => {
    expect(byKey('pr').build().on).toEqual(['pr.opened', 'pr.synchronize'])
  })

  it('la de cron trae schedule y el evento que lo consume', () => {
    const t = byKey('cron').build()
    expect(t.on).toEqual(['schedule.tick'])
    expect(t.schedule).toBeTruthy()
  })

  it('la vacía no impone nada', () => {
    expect(byKey('blank').build()).toEqual({})
  })

  it('ninguna plantilla trae id — es lo único que no puede elegir por vos', () => {
    for (const t of RULE_TEMPLATES) expect(t.build().id).toBeUndefined()
  })
})

describe('recurringRuleWarning', () => {
  // Hoy ningún evento del catálogo es recurrente — el scan sólo publica
  // cuando algo cambió (`issue.created`/`issue.status_changed`) — así que la
  // función no tiene nada que avisar todavía. El mecanismo sigue vivo para
  // el día que un productor nuevo sí lo sea.
  it('no avisa sobre ningún evento del catálogo hoy', () => {
    expect(recurringRuleWarning({ on: ['issue.created'] })).toBeNull()
    expect(recurringRuleWarning({ on: ['issue.status_changed'] })).toBeNull()
    expect(recurringRuleWarning({ on: ['pr.opened'] })).toBeNull()
    expect(recurringRuleWarning({ on: ['ci.finished'] })).toBeNull()
  })

  it('un evento que no está en el catálogo tampoco avisa', () => {
    expect(recurringRuleWarning({ on: ['algo.inventado'] })).toBeNull()
  })
})
