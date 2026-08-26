import { describe, expect, it } from 'bun:test'
import { ERROR_EXIT, SUCCESS_EXIT } from '@ia-flow/shared'
import { resolveExitCommentTarget } from '../run-outcome.js'

// La regla completa: **salida > agente > `pr-else-issue`**.
describe('resolveExitCommentTarget', () => {
  // El default cubre a la mayoría del roster sin escribir una línea de config:
  // una vez que existe un PR, casi todo comentario del pipeline es del código.
  it('sin nada declarado cae a pr-else-issue', () => {
    expect(resolveExitCommentTarget({}, SUCCESS_EXIT)).toBe('pr-else-issue')
    expect(resolveExitCommentTarget({ exits: { success: 'Done' } }, SUCCESS_EXIT)).toBe(
      'pr-else-issue',
    )
  })

  // El nivel de agente existe para que un refiner —cuyo output ES el issue—
  // cueste una línea en vez de una por salida.
  it('el default del agente aplica a todas sus salidas', () => {
    const entry = { exits: { success: 'Done', error: 'Blocked' }, commentTarget: 'issue' as const }
    expect(resolveExitCommentTarget(entry, SUCCESS_EXIT)).toBe('issue')
    expect(resolveExitCommentTarget(entry, ERROR_EXIT)).toBe('issue')
  })

  // El caso que motivó todo: un e2e-tester tiene dos clases de hallazgo. El bug
  // de implementación va al PR; "esto no hace lo que el PRD pide" manda el
  // issue a refinamiento y tiene que sobrevivir al PR que lo motivó.
  it('la salida pisa el default del agente', () => {
    const entry = {
      exits: {
        success: '$set:Labels=+e2e-checked',
        error: '$set:Labels=+agent:build',
        'back-to-refine': {
          set: '$set:Labels=+agent:refine',
          comment: 'issue' as const,
        },
      },
    }
    expect(resolveExitCommentTarget(entry, ERROR_EXIT)).toBe('pr-else-issue')
    expect(resolveExitCommentTarget({ ...entry, chosenExit: 'back-to-refine' }, ERROR_EXIT)).toBe(
      'issue',
    )
  })

  // La elección del agente vale también en el camino de éxito, igual que en
  // `resolveExit`: el resultado del run y la transición son hechos distintos.
  it('respeta la salida elegida aunque el run haya terminado bien', () => {
    const entry = {
      exits: {
        success: 'Done',
        'back-to-build': { set: 'Build', comment: 'pr' as const },
      },
      commentTarget: 'issue' as const,
      chosenExit: 'back-to-build',
    }
    expect(resolveExitCommentTarget(entry, SUCCESS_EXIT)).toBe('pr')
  })

  // Espeja a `resolveExit`: una salida que el agente pide pero no está
  // declarada cae al default del camino en vez de quedar sin destino.
  it('una salida elegida no declarada cae al default del camino', () => {
    const entry = {
      exits: { error: { set: 'Blocked', comment: 'issue' as const } },
      chosenExit: 'no-existe',
    }
    expect(resolveExitCommentTarget(entry, ERROR_EXIT)).toBe('issue')
  })
})
