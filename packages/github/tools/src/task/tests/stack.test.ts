import { describe, expect, it } from 'vitest'
import { type StackBlocker, stackOf } from '../stack.js'

const task = { owner: 'la-haus', repo: 'api' }
const blocker = (
  repo: string,
  number: number,
  pr?: { number: number; headRef: string; baseRef: string },
): StackBlocker => ({ owner: 'la-haus', repo, number, ...(pr ? { pr } : {}) })

describe('stackOf', () => {
  it('sin blockers no frena ni apila', () => {
    expect(stackOf(task, [])).toEqual({ pending: [] })
  })

  it('un blocker sin PR abierto frena', () => {
    expect(stackOf(task, [blocker('api', 1)])).toEqual({ pending: ['la-haus/api#1'] })
  })

  it('un blocker de otro repo con PR no frena ni apila: se construye contra el contrato', () => {
    expect(
      stackOf(task, [blocker('web', 2, { number: 20, headRef: 'feat/b', baseRef: 'main' })]),
    ).toEqual({ pending: [] })
  })

  it('un blocker del mismo repo con PR es la base', () => {
    expect(
      stackOf(task, [blocker('api', 1, { number: 10, headRef: 'feat/a', baseRef: 'main' })]),
    ).toEqual({ pending: [], base: { branch: 'feat/a', pr: 10, issue: 'la-haus/api#1' } })
  })

  it('compara owner y repo sin mayúsculas', () => {
    const upper = { owner: 'La-Haus', repo: 'API' }
    expect(
      stackOf(upper, [blocker('api', 1, { number: 10, headRef: 'feat/a', baseRef: 'main' })]).base
        ?.branch,
    ).toBe('feat/a')
  })

  it('una cadena del mismo repo apila sobre la punta', () => {
    const stack = stackOf(task, [
      blocker('api', 1, { number: 10, headRef: 'feat/a', baseRef: 'main' }),
      blocker('api', 2, { number: 11, headRef: 'feat/b', baseRef: 'feat/a' }),
    ])
    expect(stack).toEqual({
      pending: [],
      base: { branch: 'feat/b', pr: 11, issue: 'la-haus/api#2' },
    })
  })

  it('dos ramas independientes del mismo repo frenan a todos los del repo', () => {
    const stack = stackOf(task, [
      blocker('api', 1, { number: 10, headRef: 'feat/a', baseRef: 'main' }),
      blocker('api', 2, { number: 11, headRef: 'feat/b', baseRef: 'main' }),
      blocker('web', 3, { number: 30, headRef: 'feat/c', baseRef: 'main' }),
    ])
    expect(stack).toEqual({ pending: ['la-haus/api#1', 'la-haus/api#2'] })
  })

  it('suma los pendientes de otros repos a la base del mismo', () => {
    const stack = stackOf(task, [
      blocker('api', 1, { number: 10, headRef: 'feat/a', baseRef: 'main' }),
      blocker('web', 3),
    ])
    expect(stack).toEqual({
      pending: ['la-haus/web#3'],
      base: { branch: 'feat/a', pr: 10, issue: 'la-haus/api#1' },
    })
  })

  it('un ciclo de bases no es una cadena', () => {
    const stack = stackOf(task, [
      blocker('api', 1, { number: 10, headRef: 'feat/a', baseRef: 'feat/b' }),
      blocker('api', 2, { number: 11, headRef: 'feat/b', baseRef: 'feat/a' }),
    ])
    expect(stack.base).toBeUndefined()
    expect(stack.pending).toEqual(['la-haus/api#1', 'la-haus/api#2'])
  })
})
