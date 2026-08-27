import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import m021 from '../021-execution-logs.js'
import m023 from '../023-execution-logs-session.js'
import m053 from '../053-execution-logs-session-repair.js'

function columns(db: Database): string[] {
  return (
    db.query(`SELECT name FROM pragma_table_info('execution_logs')`).all() as Array<{
      name: string
    }>
  ).map((r) => r.name)
}

describe('sesión en execution_logs', () => {
  it('la 023 agrega las columnas en una DB fresca', () => {
    // La regresión: su hasColumn comparaba `.get()` contra `undefined` y
    // bun:sqlite devuelve null, así que daba "ya existe" para todo y los dos
    // ALTER no corrían nunca — dejando cada insert del execution log roto.
    const db = new Database(':memory:')
    m021.up(db)
    m023.up(db)
    expect(columns(db)).toContain('session_kind')
    expect(columns(db)).toContain('session_id')
  })

  it('la 023 es idempotente: correrla dos veces no explota', () => {
    const db = new Database(':memory:')
    m021.up(db)
    m023.up(db)
    expect(() => m023.up(db)).not.toThrow()
  })

  it('la 053 repara la DB que quedó con la 023 registrada pero sin columnas', () => {
    const db = new Database(':memory:')
    m021.up(db)
    expect(columns(db)).not.toContain('session_kind')
    m053.up(db)
    expect(columns(db)).toContain('session_kind')
    expect(columns(db)).toContain('session_id')
  })

  it('la 053 no hace nada en una DB sana', () => {
    const db = new Database(':memory:')
    m021.up(db)
    m023.up(db)
    expect(() => m053.up(db)).not.toThrow()
    expect(columns(db).filter((c) => c === 'session_kind')).toHaveLength(1)
  })
})
