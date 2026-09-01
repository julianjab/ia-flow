import { describe, expect, it } from 'bun:test'
import { type Steps, referencesSteps, resolveSteps } from './steps.js'

const steps: Steps = {
  triage: {
    output: { brief: 'construí X', next: 'implementer', n: 7, urgente: true },
    from: 'agent',
  },
  medir: { output: '482', from: 'script' },
}

const ok = (config: unknown, s: Steps = steps) => {
  const r = resolveSteps(config, s)
  expect(r.errors).toEqual([])
  return r.value as Record<string, unknown>
}
const errs = (config: unknown, s: Steps = steps) => resolveSteps(config, s).errors

describe('resolveSteps', () => {
  it('resuelve un campo del output de un paso', () => {
    expect(ok({ action: 'agent', brief: '{{steps.triage.output.brief}}' }).brief).toBe('construí X')
  })

  it('resuelve el output entero de un paso sin contrato', () => {
    expect(ok({ body: '{{steps.medir.output}}' }).body).toBe('482')
  })

  // Sin esto, un campo numérico del schema recibiría un string y fallaría por
  // una razón que no tiene que ver con lo que el operador escribió.
  it('un string que es SÓLO una referencia conserva el tipo nativo', () => {
    const out = ok({ n: '{{steps.triage.output.n}}', b: '{{steps.triage.output.urgente}}' })
    expect(out.n).toBe(7)
    expect(out.b).toBe(true)
  })

  it('interpolado adentro de un texto se convierte a string', () => {
    expect(ok({ brief: 'El plan: {{steps.triage.output.brief}}.' }).brief).toBe(
      'El plan: construí X.',
    )
  })

  it('resuelve adentro de objetos y arrays anidados', () => {
    const out = ok({
      body: { items: ['{{steps.medir.output}}'], meta: { x: '{{steps.medir.output}}' } },
    })
    expect(out.body).toEqual({ items: ['482'], meta: { x: '482' } })
  })

  it('tolera espacios adentro de las llaves', () => {
    expect(ok({ brief: '{{ steps.triage.output.brief }}' }).brief).toBe('construí X')
  })

  it('deja intacto lo que no referencia pasos', () => {
    expect(ok({ brief: 'texto fijo', n: 3 })).toEqual({ brief: 'texto fijo', n: 3 })
  })

  // La decisión central: acá una referencia rota NO se deja pasar. En el prompt
  // de un agente una variable desconocida queda literal y el costo es que el
  // modelo la lea; acá el costo es un paso corriendo con un encargo mutilado.
  it('un paso que no existe es un error, no un hueco', () => {
    const e = errs({ brief: '{{steps.nope.output}}' })
    expect(e).toHaveLength(1)
    expect(e[0]).toContain("'nope'")
    expect(e[0]).toContain('triage')
  })

  it('un campo que el paso no dejó es un error', () => {
    expect(errs({ brief: '{{steps.triage.output.inexistente}}' })[0]).toContain('no existe')
  })

  it('un camino que atraviesa un valor plano es un error', () => {
    expect(errs({ brief: '{{steps.medir.output.x}}' })[0]).toContain('no cuelga')
  })

  // Un modelo eligiendo el agentId elige el prompt, las tools, la policy de
  // bash y el provider del próximo run.
  it('un campo de ejecución NO puede salir de un agente', () => {
    const e = errs({ action: 'agent', agentId: '{{steps.triage.output.next}}' })
    expect(e).toHaveLength(1)
    expect(e[0]).toContain('agentId')
    expect(e[0]).toContain('triage')
  })

  // La compuerta: con la lista de destinos declarada, el patrón pasa a ser el
  // de `select_exit` — el operador declara el espacio, el modelo elige adentro.
  it('agentId SÍ puede salir de un agente cuando la acción declara allowAgents', () => {
    const out = ok({
      action: 'agent',
      agentId: '{{steps.triage.output.next}}',
      allowAgents: ['implementer', 'reviewer'],
    })
    expect(out.agentId).toBe('implementer')
  })

  it('una lista vacía no abre la compuerta', () => {
    const e = errs({ action: 'agent', agentId: '{{steps.triage.output.next}}', allowAgents: [] })
    expect(e[0]).toContain('agentId')
  })

  it('el error dice cómo abrirla', () => {
    expect(errs({ agentId: '{{steps.triage.output.next}}' })[0]).toContain('allowAgents')
  })

  // Los demás campos de ejecución no tienen compuerta: no hay un espacio
  // enumerable que valga la pena, una url de lista blanca se escribe directo.
  it('la compuerta de agentId no abre los otros campos', () => {
    const e = errs({ url: '{{steps.triage.output.brief}}', allowAgents: ['x'] })
    expect(e[0]).toContain('url')
  })

  it('reporta qué pasos usó, y quién los produjo', () => {
    const r = resolveSteps(
      { brief: '{{steps.triage.output.brief}}', body: '{{steps.medir.output}}' },
      steps,
    )
    expect(r.used).toEqual([
      { id: 'triage', from: 'agent' },
      { id: 'medir', from: 'script' },
    ])
  })

  it('los mismos campos SÍ pueden salir de un script', () => {
    const s: Steps = { calc: { output: 'implementer', from: 'script' } }
    expect(ok({ agentId: '{{steps.calc.output}}' }, s).agentId).toBe('implementer')
  })

  it('un campo de contenido sí puede salir de un agente', () => {
    expect(ok({ brief: '{{steps.triage.output.brief}}' }).brief).toBe('construí X')
  })

  it('acumula todos los errores, no sólo el primero', () => {
    expect(errs({ a: '{{steps.nope.output}}', b: '{{steps.tampoco.output}}' })).toHaveLength(2)
  })
})

describe('referencesSteps', () => {
  it('detecta una referencia anidada', () => {
    expect(referencesSteps({ body: { x: ['{{steps.a.output}}'] } })).toBe(true)
  })

  it('es falso cuando no hay ninguna', () => {
    expect(referencesSteps({ brief: 'texto {{event.type}} fijo' })).toBe(false)
  })
})
