import { describe, expect, it } from 'vitest'
import { whyContext, whyScope } from '../why'
import { proposal } from './fixtures'

describe('el «¿Por qué?» de una mejora', () => {
  it('habla de la tarea que la originó; sin tarea, de todo el runner', () => {
    expect(whyScope(proposal())).toEqual({ kind: 'task', ref: 'acme/api#7' })
    expect(whyScope(proposal({ task_ref: undefined }))).toEqual({ kind: 'general' })
  })

  it('el contexto trae la mejora entera, cómo ajustarla y dónde buscar la evidencia', () => {
    const text = whyContext(proposal({ execution_id: 'ex9' }))
    expect(text).toContain('mejora imp-1, que propuso el agente «retrospective» sobre acme/api#7')
    expect(text).toContain('(PR https://github.com/acme/api/pull/9, ejecución ex9)')
    expect(text).toContain('assistant_revise_improvement con id imp-1')
    expect(text).toContain('Título: Documentar el comando de tests')
    expect(text).toContain('get_task y get_trace')
    expect(text.endsWith('Mi pregunta:')).toBe(true)
  })

  it('recorta un cuerpo muy largo', () => {
    const text = whyContext(proposal({ body: 'x'.repeat(5000) }))
    expect(text).toContain('… [recortado]')
    expect(text.length).toBeLessThan(5000)
  })
})
