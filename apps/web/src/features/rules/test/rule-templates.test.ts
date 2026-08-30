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
  // El mismo pozo que el "filtro 0" de la activación vieja: la regla se guarda
  // bien, corre bien, y re-dispara sobre el issue que ella misma acaba de
  // mover. Nada da error.
  it('avisa sobre issue.scanned sin ninguna condición', () => {
    expect(recurringRuleWarning({ on: ['issue.scanned'] })).toContain('indefinidamente')
  })

  it('una condición alcanza para acotarla', () => {
    expect(recurringRuleWarning({ on: ['issue.scanned'], when: [{ field: 'status' }] })).toBeNull()
  })

  it('un criterio en texto libre también', () => {
    expect(recurringRuleWarning({ on: ['issue.scanned'], whenText: 'menciona pagos' })).toBeNull()
  })

  // Un `pr.opened` es un hecho de una vez: no se repite por sí solo, así que
  // avisarlo sería ruido.
  it('no avisa sobre eventos que no se repiten', () => {
    expect(recurringRuleWarning({ on: ['pr.opened'] })).toBeNull()
    expect(recurringRuleWarning({ on: ['ci.finished'] })).toBeNull()
  })

  it('un whenText en blanco no cuenta como condición', () => {
    expect(recurringRuleWarning({ on: ['issue.scanned'], whenText: '   ' })).not.toBeNull()
  })
})
