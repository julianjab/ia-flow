import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import migration from '../080-raw-github-event-types.js'

function setup(): Database {
  const db = new Database(':memory:')
  db.run(`
    CREATE TABLE rules (
      id              TEXT PRIMARY KEY NOT NULL,
      on_types        TEXT NOT NULL,
      when_conditions TEXT
    )
  `)
  return db
}

function insertRule(
  db: Database,
  id: string,
  onTypes: string[],
  when: unknown[] | null = null,
): void {
  db.run(`INSERT INTO rules (id, on_types, when_conditions) VALUES (?, ?, ?)`, [
    id,
    JSON.stringify(onTypes),
    when ? JSON.stringify(when) : null,
  ])
}

function readRule(db: Database, id: string): { on: string[]; when: unknown[] | null } {
  const row = db.query('SELECT on_types, when_conditions FROM rules WHERE id = ?').get(id) as {
    on_types: string
    when_conditions: string | null
  }
  return {
    on: JSON.parse(row.on_types),
    when: row.when_conditions ? JSON.parse(row.when_conditions) : null,
  }
}

describe('080-raw-github-event-types', () => {
  it('pr.opened + pr.synchronize se migran a pull_request con un OR de actions', () => {
    const db = setup()
    insertRule(db, 'r1', ['pr.opened', 'pr.synchronize'])
    migration.up(db)

    const r = readRule(db, 'r1')
    expect(r.on).toEqual(['pull_request'])
    expect(r.when).toEqual([
      { field: 'action', op: '=', value: 'opened' },
      { field: 'action', op: '=', value: 'reopened', logic: 'or' },
      { field: 'action', op: '=', value: 'synchronize', logic: 'or' },
    ])
  })

  it('ci.finished se migra a check_suite + workflow_run con action=completed', () => {
    const db = setup()
    insertRule(db, 'r2', ['ci.finished'])
    migration.up(db)

    const r = readRule(db, 'r2')
    expect(r.on.sort()).toEqual(['check_suite', 'workflow_run'])
    expect(r.when).toEqual([{ field: 'action', op: '=', value: 'completed' }])
  })

  it('issue_comment.created / issues.opened se migran por prefijo dinámico', () => {
    const db = setup()
    insertRule(db, 'r3', ['issue_comment.created'])
    insertRule(db, 'r4', ['issues.opened'])
    migration.up(db)

    expect(readRule(db, 'r3')).toEqual({
      on: ['issue_comment'],
      when: [{ field: 'action', op: '=', value: 'created' }],
    })
    expect(readRule(db, 'r4')).toEqual({
      on: ['issues'],
      when: [{ field: 'action', op: '=', value: 'opened' }],
    })
  })

  it('conserva un when existente y le agrega el nuevo grupo, AND', () => {
    const db = setup()
    insertRule(db, 'r5', ['pr.synchronize'], [{ field: 'pr.author', op: '=', value: 'julianjab' }])
    migration.up(db)

    const r = readRule(db, 'r5')
    expect(r.when).toEqual([
      { field: 'pr.author', op: '=', value: 'julianjab' },
      { field: 'action', op: '=', value: 'synchronize' },
    ])
  })

  it('conserva tipos no-GitHub y no-curados intactos junto a los migrados', () => {
    const db = setup()
    insertRule(db, 'r6', ['issue.status_changed', 'pr.review_submitted'])
    migration.up(db)

    const r = readRule(db, 'r6')
    expect(r.on.sort()).toEqual(['issue.status_changed', 'pull_request_review'])
    expect(r.when).toEqual([{ field: 'action', op: '=', value: 'submitted' }])
  })

  it('una regla sin ningún tipo curado no se toca', () => {
    const db = setup()
    insertRule(db, 'r7', ['issue.status_changed'], [{ field: 'status', op: '=', value: 'Ready' }])
    migration.up(db)

    expect(readRule(db, 'r7')).toEqual({
      on: ['issue.status_changed'],
      when: [{ field: 'status', op: '=', value: 'Ready' }],
    })
  })

  it('pr.merged solo (sin otros tipos de pull_request) se saltea para revisión manual', () => {
    const db = setup()
    insertRule(db, 'r8', ['pr.merged'])
    migration.up(db)

    // Se deja intacta — el operador la migra a mano a
    // on: ['pull_request'], when: [action=closed, pr.merged=true].
    expect(readRule(db, 'r8')).toEqual({ on: ['pr.merged'], when: null })
  })

  it('pr.merged junto con pr.opened se saltea (OR-de-AND no expresable)', () => {
    const db = setup()
    insertRule(db, 'r9', ['pr.opened', 'pr.merged'])
    migration.up(db)

    expect(readRule(db, 'r9')).toEqual({ on: ['pr.opened', 'pr.merged'], when: null })
  })

  it('when_conditions en formato Record se saltea para revisión manual', () => {
    const db = setup()
    db.run(`INSERT INTO rules (id, on_types, when_conditions) VALUES (?, ?, ?)`, [
      'r10',
      JSON.stringify(['pr.opened']),
      JSON.stringify({ status: 'Ready' }),
    ])
    migration.up(db)

    const row = db.query('SELECT on_types, when_conditions FROM rules WHERE id = ?').get('r10') as {
      on_types: string
      when_conditions: string
    }
    expect(JSON.parse(row.on_types)).toEqual(['pr.opened'])
    expect(JSON.parse(row.when_conditions)).toEqual({ status: 'Ready' })
  })

  it('es idempotente: correrla dos veces no vuelve a migrar lo ya migrado', () => {
    const db = setup()
    insertRule(db, 'r11', ['pr.opened'])
    migration.up(db)
    const once = readRule(db, 'r11')
    migration.up(db)
    expect(readRule(db, 'r11')).toEqual(once)
  })
})
