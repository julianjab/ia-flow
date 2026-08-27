import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { SqliteEnvVarRepository } from '../SqliteEnvVarRepository.js'

// Claves de fantasía: estos tests escriben en `Bun.env` de verdad (es lo que
// `loadIntoProcess` hace), así que no pueden usar nombres reales sin pisarle
// el entorno al resto de la suite.
const AMBIENT = 'IA_FLOW_TEST_AMBIENT'
const SAVED = 'IA_FLOW_TEST_SAVED'

function setup(): { repo: SqliteEnvVarRepository; db: Database } {
  const db = new Database(':memory:')
  db.run(`CREATE TABLE global_settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)`)
  return { repo: new SqliteEnvVarRepository(db), db }
}

function clearEnv() {
  for (const k of [AMBIENT, SAVED]) delete (Bun.env as Record<string, string | undefined>)[k]
}

describe('SqliteEnvVarRepository — de dónde salió cada valor', () => {
  let repo: SqliteEnvVarRepository

  beforeEach(() => {
    clearEnv()
    repo = setup().repo
  })
  afterEach(clearEnv)

  it('no reporta nada antes del primer loadIntoProcess', () => {
    expect(repo.shadowedEnvKeys()).toEqual([])
  })

  it('anota la clave cuando pisa un valor distinto del ambiente', () => {
    ;(Bun.env as Record<string, string>)[AMBIENT] = 'del-shell'
    repo.set(AMBIENT, 'de-la-ui')
    // `set` ya lo anota (ver su comentario), pero el caso que importa es el
    // del boot: el proceso arranca con el valor del ambiente y la DB lo pisa.
    const fresh = setup()
    fresh.db.run(`INSERT INTO global_settings (key, value) VALUES (?, ?)`, [
      `env.${AMBIENT}`,
      'de-la-ui',
    ])
    fresh.repo.loadIntoProcess()

    expect(fresh.repo.shadowedEnvKeys()).toEqual([AMBIENT])
    expect(Bun.env[AMBIENT]).toBe('de-la-ui')
  })

  it('no la anota si el ambiente traía EXACTAMENTE el mismo valor', () => {
    // Un compose que repite el token que ya está guardado no es un override
    // que valga la pena mostrarle a nadie — sería ruido en toda la pantalla.
    ;(Bun.env as Record<string, string>)[AMBIENT] = 'igual'
    const { repo: r, db } = setup()
    db.run(`INSERT INTO global_settings (key, value) VALUES (?, ?)`, [`env.${AMBIENT}`, 'igual'])
    r.loadIntoProcess()

    expect(r.shadowedEnvKeys()).toEqual([])
  })

  it('no la anota cuando el ambiente no traía nada', () => {
    const { repo: r, db } = setup()
    db.run(`INSERT INTO global_settings (key, value) VALUES (?, ?)`, [`env.${SAVED}`, 'v'])
    r.loadIntoProcess()

    expect(r.shadowedEnvKeys()).toEqual([])
    expect(Bun.env[SAVED]).toBe('v')
  })

  it('guardar sobre una que venía del ambiente TAMBIÉN cuenta como override', () => {
    // Sin esto el cartel diría "guardada" hasta el próximo reinicio y
    // "sobrescribe el entorno" después: el mismo estado contado de dos formas.
    ;(Bun.env as Record<string, string>)[AMBIENT] = 'del-shell'
    repo.set(AMBIENT, 'de-la-ui')

    expect(repo.shadowedEnvKeys()).toEqual([AMBIENT])
  })

  it('borrar la fila devuelve el mando al ambiente', () => {
    ;(Bun.env as Record<string, string>)[AMBIENT] = 'del-shell'
    repo.set(AMBIENT, 'de-la-ui')
    repo.delete(AMBIENT)

    expect(repo.shadowedEnvKeys()).toEqual([])
    expect(repo.get(AMBIENT)).toBeNull()
  })

  it('un segundo loadIntoProcess describe esa corrida, no la unión', () => {
    ;(Bun.env as Record<string, string>)[AMBIENT] = 'del-shell'
    const { repo: r, db } = setup()
    db.run(`INSERT INTO global_settings (key, value) VALUES (?, ?)`, [`env.${AMBIENT}`, 'de-la-ui'])
    r.loadIntoProcess()
    expect(r.shadowedEnvKeys()).toEqual([AMBIENT])

    // Segunda corrida: `Bun.env` ya tiene el valor de la DB, así que no hay
    // nada que pisar y el reporte tiene que quedar vacío.
    r.loadIntoProcess()
    expect(r.shadowedEnvKeys()).toEqual([])
  })
})
