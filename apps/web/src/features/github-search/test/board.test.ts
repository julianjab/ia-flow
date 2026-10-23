import { describe, expect, it } from 'vitest'
import { addTargets, boardEntryOf, columnOptions } from '@/features/github-search/board'

describe('board', () => {
  it('boardEntryOf busca sin mayúsculas', () => {
    const board = new Map([['acme/api#7', { ref: 'acme/api#7', status: 'Review' }]])
    expect(boardEntryOf(board, 'Acme/API#7')).toEqual({ ref: 'acme/api#7', status: 'Review' })
    expect(boardEntryOf(board, 'acme/api#8')).toBeNull()
  })

  it('un issue entra en los proyectos que tienen su repo; si ninguno lo declara, en todos', () => {
    const projects = [
      { id: 'core', repos: ['acme/api'] },
      { id: 'web', repos: ['acme/web'] },
    ]
    expect(addTargets(projects, 'ACME/api#3').map((p) => p.id)).toEqual(['core'])
    expect(addTargets(projects, 'acme/cli#3').map((p) => p.id)).toEqual(['core', 'web'])
  })

  it('las columnas: Todo primero «(por defecto)», el resto en su orden', () => {
    expect(columnOptions(['Refine', 'Todo', 'Build'])).toEqual([
      { status: 'Todo', label: 'Todo (por defecto)' },
      { status: 'Refine', label: 'Refine' },
      { status: 'Build', label: 'Build' },
    ])
    expect(columnOptions(undefined)).toEqual([{ status: undefined, label: 'Todo (por defecto)' }])
  })
})
