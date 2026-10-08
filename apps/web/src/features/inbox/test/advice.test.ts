import { describe, expect, it } from 'vitest'
import { actionFailure, nextOf } from '@/features/inbox/queue/advice'
import { execution, item } from '@/features/inbox/test/fixtures'

describe('actionFailure', () => {
  it('un error de red dice que el runner no respondió y que se revise la conexión', () => {
    expect(actionFailure('Relanzar', 'Network Error')).toEqual({
      what: 'No se pudo relanzar: el runner no respondió (Network Error).',
      next: 'Revisá la conexión y reintentá.',
    })
  })

  it('quita el «…» del botón y distingue sesión vencida y tarea cambiada', () => {
    expect(actionFailure('Mergear…', '401 Bad credentials').next).toContain('iniciar sesión')
    expect(actionFailure('Mergear…', 'el PR no es mergeable (409)').what).toBe(
      'No se pudo mergear: el PR no es mergeable (409)',
    )
    expect(actionFailure('Aprobar…', 'boom').next).toContain('asistente')
  })
})

describe('nextOf', () => {
  it('una falla dice si fue el runner o el agente', () => {
    const fail = (by: 'runtime' | 'agent') =>
      item({ group: 'fail', execution: execution({ failure: { by, message: 'x' } }) })
    expect(nextOf({ type: 'fail', item: fail('runtime') })).toContain('Falló el runner')
    expect(nextOf({ type: 'fail', item: fail('agent') })).toContain('lo que dijo el agente')
  })

  it('responder explica qué pasa con el texto; un tipo sin paso no dice nada', () => {
    expect(nextOf({ type: 'answer', item: item() })).toContain('comentario')
    expect(nextOf({ type: 'other', item: item() })).toBeUndefined()
  })
})
