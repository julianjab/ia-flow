import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import migration, { planRowUpdate } from '../080-raw-github-event-types.js'

function setup(): Database {
  const db = new Database(':memory:')
  for (const table of ['rules', 'waits']) {
    db.run(`
      CREATE TABLE ${table} (
        id              TEXT PRIMARY KEY NOT NULL,
        on_types        TEXT NOT NULL,
        when_conditions TEXT
      )
    `)
  }
  return db
}

function insertRow(
  db: Database,
  table: 'rules' | 'waits',
  id: string,
  onTypes: string[],
  when: unknown[] | null = null,
): void {
  db.run(`INSERT INTO ${table} (id, on_types, when_conditions) VALUES (?, ?, ?)`, [
    id,
    JSON.stringify(onTypes),
    when ? JSON.stringify(when) : null,
  ])
}

function readRow(
  db: Database,
  table: 'rules' | 'waits',
  id: string,
): { on: string[]; when: unknown[] | null } {
  const row = db.query(`SELECT on_types, when_conditions FROM ${table} WHERE id = ?`).get(id) as {
    on_types: string
    when_conditions: string | null
  }
  return {
    on: JSON.parse(row.on_types),
    when: row.when_conditions ? JSON.parse(row.when_conditions) : null,
  }
}

describe('planRowUpdate — casos puros', () => {
  it('pr.opened + pr.synchronize: dos ramas OR, sin when previo', () => {
    const plan = planRowUpdate({
      id: 'r1',
      on_types: JSON.stringify(['pr.opened', 'pr.synchronize']),
      when_conditions: null,
    })
    expect(plan).toEqual({
      onTypes: ['pull_request'],
      when: [
        { field: 'action', op: '=', value: 'opened' },
        { field: 'action', op: '=', value: 'reopened', logic: 'or' },
        { field: 'action', op: '=', value: 'synchronize', logic: 'or' },
      ],
    })
  })

  // El bug que encontró la revisión: pegar la condición de action al final
  // del when existente en vez de cruzar-producto rompía CUALQUIER regla con
  // más de una action posible — la rama `reopened` quedaba sin `isDraft`.
  it('un when previo se cruza-producto con CADA rama, no se concatena', () => {
    const plan = planRowUpdate({
      id: 'r2',
      on_types: JSON.stringify(['pr.opened']),
      when_conditions: JSON.stringify([{ field: 'pr.isDraft', op: '=', value: 'false' }]),
    })
    expect(plan).toEqual({
      onTypes: ['pull_request'],
      when: [
        { field: 'pr.isDraft', op: '=', value: 'false' },
        { field: 'action', op: '=', value: 'opened' },
        { field: 'pr.isDraft', op: '=', value: 'false', logic: 'or' },
        { field: 'action', op: '=', value: 'reopened' },
      ],
    })
  })

  // El segundo bug: un when previo con su propio OR perdía el filtro de
  // action en alguna rama si se apendeaba en vez de cruzar-producto.
  it('un when previo con su propio OR conserva el filtro de action en las dos ramas', () => {
    const plan = planRowUpdate({
      id: 'r3',
      on_types: JSON.stringify(['issue_comment.created']),
      when_conditions: JSON.stringify([
        { field: 'author', op: '=', value: 'a' },
        { field: 'author', op: '=', value: 'b', logic: 'or' },
      ]),
    })
    expect(plan).toEqual({
      onTypes: ['issue_comment'],
      when: [
        { field: 'author', op: '=', value: 'a' },
        { field: 'action', op: '=', value: 'created' },
        { field: 'author', op: '=', value: 'b', logic: 'or' },
        { field: 'action', op: '=', value: 'created' },
      ],
    })
  })

  it('ci.finished: check_suite + workflow_run con action=completed', () => {
    const plan = planRowUpdate({
      id: 'r4',
      on_types: JSON.stringify(['ci.finished']),
      when_conditions: null,
    })
    expect(plan && 'onTypes' in plan && plan.onTypes.sort()).toEqual([
      'check_suite',
      'workflow_run',
    ])
    expect(plan && 'when' in plan && plan.when).toEqual([
      { field: 'action', op: '=', value: 'completed' },
    ])
  })

  it('pr.merged sola: pull_request con action=closed AND pr.merged=true', () => {
    const plan = planRowUpdate({
      id: 'r5',
      on_types: JSON.stringify(['pr.merged']),
      when_conditions: null,
    })
    expect(plan).toEqual({
      onTypes: ['pull_request'],
      when: [
        { field: 'action', op: '=', value: 'closed' },
        { field: 'pr.merged', op: '=', value: 'true' },
      ],
    })
  })

  it('pr.closed sola: pull_request con action=closed AND pr.merged=false', () => {
    const plan = planRowUpdate({
      id: 'r6',
      on_types: JSON.stringify(['pr.closed']),
      when_conditions: null,
    })
    expect(plan).toEqual({
      onTypes: ['pull_request'],
      when: [
        { field: 'action', op: '=', value: 'closed' },
        { field: 'pr.merged', op: '=', value: 'false' },
      ],
    })
  })

  it('pr.merged + pr.closed juntas colapsan a un solo action=closed, sin el flag', () => {
    const plan = planRowUpdate({
      id: 'r7',
      on_types: JSON.stringify(['pr.merged', 'pr.closed']),
      when_conditions: null,
    })
    expect(plan).toEqual({
      onTypes: ['pull_request'],
      when: [{ field: 'action', op: '=', value: 'closed' }],
    })
  })

  // El caso que la versión anterior de esta migración se negaba a migrar:
  // pr.merged/pr.closed conviviendo con otro tipo de pull_request. Ahora sí
  // es expresable como cross-product de grupos OR.
  it('pr.opened + pr.merged: dos ramas OR, una simple y una con el flag', () => {
    const plan = planRowUpdate({
      id: 'r8',
      on_types: JSON.stringify(['pr.opened', 'pr.merged']),
      when_conditions: null,
    })
    expect(plan).toEqual({
      onTypes: ['pull_request'],
      when: [
        { field: 'action', op: '=', value: 'opened' },
        { field: 'action', op: '=', value: 'reopened', logic: 'or' },
        { field: 'action', op: '=', value: 'closed', logic: 'or' },
        { field: 'pr.merged', op: '=', value: 'true' },
      ],
    })
  })

  // El `when` evalúa contra `event.payload`, que no lleva el tipo del evento
  // (`match.ts`) — así que una condición de `action` compartida no puede
  // distinguir "esto vino de un pr.review_submitted" de "esto vino de un
  // evento sin `action`". Mezclar un tipo curado con uno no curado se
  // saltea, no se migra a medias.
  it('un tipo curado mezclado con uno NO curado se saltea (el when no puede distinguir el origen)', () => {
    const plan = planRowUpdate({
      id: 'r9',
      on_types: JSON.stringify(['issue.status_changed', 'pr.review_submitted']),
      when_conditions: null,
    })
    expect(plan && 'skip' in plan && plan.skip).toBe(true)
  })

  // Mismo motivo: dos tipos curados que requieren `action` DISTINTA no
  // pueden compartir un `when` — `issues.opened` sólo debería disparar con
  // `action=opened` en un evento `issues`, no en cualquiera.
  it('dos tipos curados con requisitos de action distintos se saltean', () => {
    const plan = planRowUpdate({
      id: 'r9b',
      on_types: JSON.stringify(['issues.opened', 'pr.synchronize']),
      when_conditions: null,
    })
    expect(plan && 'skip' in plan && plan.skip).toBe(true)
  })

  // ci.finished SÍ mapea a dos tipos crudos, pero a propósito: son el mismo
  // hecho (terminó el CI), así que compartir `action=completed` es correcto.
  it('ci.finished sola sigue migrando aunque mapee a dos tipos crudos', () => {
    const plan = planRowUpdate({
      id: 'r9c',
      on_types: JSON.stringify(['ci.finished']),
      when_conditions: null,
    })
    expect(plan && 'onTypes' in plan).toBe(true)
  })

  it('una fila sin ningún tipo curado no se toca (null)', () => {
    expect(
      planRowUpdate({
        id: 'r10',
        on_types: JSON.stringify(['issue.status_changed']),
        when_conditions: null,
      }),
    ).toBeNull()
  })

  it('when_conditions en formato Record se saltea para revisión manual', () => {
    const plan = planRowUpdate({
      id: 'r11',
      on_types: JSON.stringify(['pr.opened']),
      when_conditions: JSON.stringify({ status: 'Ready' }),
    })
    expect(plan).toEqual({
      skip: true,
      reason: 'when en formato Record — necesita migración MANUAL',
    })
  })
})

describe('080-raw-github-event-types — up()', () => {
  it('migra rules y waits por igual (mismas columnas)', () => {
    const db = setup()
    insertRow(db, 'rules', 'rule-1', ['pr.opened'])
    insertRow(db, 'waits', 'wait-1', ['ci.finished'])
    migration.up(db)

    expect(readRow(db, 'rules', 'rule-1').on).toEqual(['pull_request'])
    expect(readRow(db, 'waits', 'wait-1').on.sort()).toEqual(['check_suite', 'workflow_run'])
  })

  it('es idempotente: correrla dos veces no vuelve a migrar lo ya migrado', () => {
    const db = setup()
    insertRow(db, 'rules', 'r1', ['pr.opened'])
    migration.up(db)
    const once = readRow(db, 'rules', 'r1')
    migration.up(db)
    expect(readRow(db, 'rules', 'r1')).toEqual(once)
  })

  it('una fila con when Record queda intacta', () => {
    const db = setup()
    db.run(`INSERT INTO rules (id, on_types, when_conditions) VALUES (?, ?, ?)`, [
      'r2',
      JSON.stringify(['pr.opened']),
      JSON.stringify({ status: 'Ready' }),
    ])
    migration.up(db)
    const row = readRow(db, 'rules', 'r2')
    expect(row.on).toEqual(['pr.opened'])
    expect(row.when).toEqual({ status: 'Ready' } as never)
  })
})
