import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import { parseFieldAssignments } from '@ia-flow/agent-engine'
import { applyMultiValueOps, isMultiValueField } from '@ia-flow/issue-sources'
import migration, { mergeLabelsIntoSet } from '../039-outcomes-labels-into-fields.js'

describe('mergeLabelsIntoSet', () => {
  it('crea el $set: cuando el slot estaba vacío', () => {
    expect(mergeLabelsIntoSet(null, '$labels:+agent:build')).toBe('$set:Labels=+agent:build')
  })

  it('concatena al cuerpo de un $set: existente', () => {
    expect(mergeLabelsIntoSet('$set:status=Done', '$labels:+ci-checked,-stale')).toBe(
      '$set:status=Done,Labels=+ci-checked,-stale',
    )
  })

  it('expande la forma corta de status para no perder la transición', () => {
    // Un slot podía tener status pelado Y labels: fusionarlos sin expandir
    // habría dejado el nombre del status como si fuera un campo.
    expect(mergeLabelsIntoSet('In Review', '$labels:+ci-checked')).toBe(
      '$set:status=In Review,Labels=+ci-checked',
    )
  })

  it('convierte un $labels: guardado en la columna de campo', () => {
    // El applyOutcome viejo lo aceptaba en cualquier slot; sin convertirlo,
    // el código nuevo lo trataría como nombre de status.
    expect(mergeLabelsIntoSet('$labels:+x', null)).toBe('$set:Labels=+x')
  })

  it('acumula las ops cuando el $labels: inline convive con la columna _labels', () => {
    expect(mergeLabelsIntoSet('$labels:+x', '$labels:-y')).toBe('$set:Labels=+x,Labels=-y')
  })

  it('no toca el slot cuando no había labels', () => {
    expect(mergeLabelsIntoSet('$set:status=Done', null)).toBeNull()
    expect(mergeLabelsIntoSet('$set:status=Done', '')).toBeNull()
  })

  it('tolera un valor sin el prefijo $labels:', () => {
    expect(mergeLabelsIntoSet(null, '+suelto')).toBe('$set:Labels=+suelto')
  })
})

function setup(): Database {
  const db = new Database(':memory:')
  db.run(`
    CREATE TABLE agents (
      id                 TEXT PRIMARY KEY,
      on_process         TEXT,
      on_finish          TEXT,
      on_error           TEXT,
      on_process_labels  TEXT,
      on_finish_labels   TEXT,
      on_error_labels    TEXT
    )
  `)
  return db
}

describe('039-outcomes-labels-into-fields', () => {
  it('convierte los tres slots y dropea las columnas', () => {
    const db = setup()
    db.run(
      `INSERT INTO agents (id, on_process, on_finish, on_error,
        on_process_labels, on_finish_labels, on_error_labels)
       VALUES ('refiner', NULL, NULL, NULL,
        '$labels:-agent:refine', '$labels:+agent:build', '$labels:+blocked')`,
    )

    migration.up(db)

    const row = db.query('SELECT * FROM agents WHERE id = ?').get('refiner') as Record<
      string,
      unknown
    >
    expect(row.on_process).toBe('$set:Labels=-agent:refine')
    expect(row.on_finish).toBe('$set:Labels=+agent:build')
    expect(row.on_error).toBe('$set:Labels=+blocked')

    const cols = (db.query('PRAGMA table_info(agents)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    )
    expect(cols).not.toContain('on_process_labels')
    expect(cols).not.toContain('on_finish_labels')
    expect(cols).not.toContain('on_error_labels')
  })

  it('fusiona status y labels que convivían en el mismo slot', () => {
    const db = setup()
    db.run(
      `INSERT INTO agents (id, on_finish, on_finish_labels)
       VALUES ('impl', '$set:Status=done', '$labels:+ci-checked')`,
    )
    migration.up(db)
    expect(
      (db.query('SELECT on_finish FROM agents WHERE id = ?').get('impl') as { on_finish: string })
        .on_finish,
    ).toBe('$set:Status=done,Labels=+ci-checked')
  })

  it('convierte un $labels: inline aunque las columnas _labels ya no existan', () => {
    const db = new Database(':memory:')
    db.run(
      'CREATE TABLE agents (id TEXT PRIMARY KEY, on_process TEXT, on_finish TEXT, on_error TEXT)',
    )
    db.run(`INSERT INTO agents (id, on_finish) VALUES ('legacy', '$labels:+x')`)
    migration.up(db)
    expect(
      (
        db.query('SELECT on_finish FROM agents WHERE id = ?').get('legacy') as {
          on_finish: string
        }
      ).on_finish,
    ).toBe('$set:Labels=+x')
  })

  it('deja intactos los slots sin labels', () => {
    const db = setup()
    db.run(`INSERT INTO agents (id, on_finish) VALUES ('plain', '$set:status=Refined')`)
    migration.up(db)
    expect(
      (db.query('SELECT on_finish FROM agents WHERE id = ?').get('plain') as { on_finish: string })
        .on_finish,
    ).toBe('$set:status=Refined')
  })

  it('es idempotente si las columnas ya no están', () => {
    const db = new Database(':memory:')
    db.run('CREATE TABLE agents (id TEXT PRIMARY KEY, on_finish TEXT)')
    db.run(`INSERT INTO agents (id, on_finish) VALUES ('a', '$set:Labels=+x')`)
    expect(() => migration.up(db)).not.toThrow()
    expect(
      (db.query('SELECT on_finish FROM agents WHERE id = ?').get('a') as { on_finish: string })
        .on_finish,
    ).toBe('$set:Labels=+x')
  })
})

// ─── Equivalencia de comportamiento con el canal viejo ───────────────────────
//
// Los tests de arriba prueban que la migración escribe el string esperado.
// Eso no alcanza para decir que una config legacy sigue haciendo lo mismo: el
// string migrado lo consume otro pipeline (parseFieldAssignments →
// applyMultiValueOps en el source) que el `$labels:` viejo nunca tocaba. Acá
// se cierra el círculo — se aplica el outcome migrado sobre un set de labels
// y se compara contra lo que el canal viejo habría producido, que era
// exactamente `applyMultiValueOps` sobre el spec crudo.

/** Simula lo que hace un source al recibir el outcome migrado: parsea el
 *  `$set:` y resuelve el campo multi-valor contra las labels vigentes. */
function labelsAfterOutcome(outcome: string, current: string[]): string[] {
  const body = outcome.startsWith('$set:') ? outcome.slice('$set:'.length) : ''
  const spec = parseFieldAssignments(body).find((p) => isMultiValueField(p.field))?.value
  return spec === undefined ? current : applyMultiValueOps(current, spec)
}

describe('039 — equivalencia con el canal $labels: viejo', () => {
  const CURRENT = ['agent:build', 'bug']

  const CASES: Array<{ name: string; field: string | null; spec: string }> = [
    { name: 'añadir', field: null, spec: '+agent:review' },
    { name: 'quitar', field: null, spec: '-agent:build' },
    { name: 'añadir y quitar en el mismo spec', field: null, spec: '+agent:review,-agent:build' },
    { name: 'reemplazo total', field: null, spec: '=solo-esta' },
    { name: 'reemplazo vacío', field: null, spec: '=' },
    {
      name: 'labels conviviendo con un $set: de status',
      field: '$set:status=Done',
      spec: '+x,-bug',
    },
    { name: 'labels conviviendo con la forma corta de status', field: 'In Review', spec: '+x' },
  ]

  for (const { name, field, spec } of CASES) {
    it(`${name}: el outcome migrado produce las mismas labels que el $labels: original`, () => {
      const migrated = mergeLabelsIntoSet(field, `$labels:${spec}`)
      expect(migrated).not.toBeNull()
      expect(labelsAfterOutcome(migrated as string, CURRENT)).toEqual(
        applyMultiValueOps(CURRENT, spec),
      )
    })
  }

  it('un $labels: inline en el slot de campo también conserva su efecto', () => {
    const migrated = mergeLabelsIntoSet('$labels:+agent:review,-bug', null)
    expect(labelsAfterOutcome(migrated as string, CURRENT)).toEqual(
      applyMultiValueOps(CURRENT, '+agent:review,-bug'),
    )
  })

  it('la transición al status no se pierde al fusionar', () => {
    const migrated = mergeLabelsIntoSet('In Review', '$labels:+x') as string
    const pairs = parseFieldAssignments(migrated.slice('$set:'.length))
    expect(pairs.find((p) => p.field.toLowerCase() === 'status')?.value).toBe('In Review')
  })
})
