import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { SqliteEnvVarRepository } from '../SqliteEnvVarRepository.js'

// Claves de fantasía: estos tests escriben en `Bun.env` de verdad (es lo que
// `loadIntoProcess` hace), así que no pueden usar nombres reales sin pisarle
// el entorno al resto de la suite.
const AMBIENT = 'IA_FLOW_TEST_AMBIENT'
const SAVED = 'IA_FLOW_TEST_SAVED'

function setup(rows: Record<string, string> = {}): SqliteEnvVarRepository {
  const db = new Database(':memory:')
  db.run(`CREATE TABLE global_settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)`)
  for (const [k, v] of Object.entries(rows)) {
    db.run(`INSERT INTO global_settings (key, value) VALUES (?, ?)`, [`env.${k}`, v])
  }
  return new SqliteEnvVarRepository(db)
}

function clearEnv() {
  for (const k of [AMBIENT, SAVED]) delete (Bun.env as Record<string, string | undefined>)[k]
}

describe('SqliteEnvVarRepository — el entorno gana', () => {
  beforeEach(clearEnv)
  afterEach(clearEnv)

  it('loadIntoProcess NO pisa lo que el ambiente ya traía', () => {
    ;(Bun.env as Record<string, string>)[AMBIENT] = 'del-compose'
    const repo = setup({ [AMBIENT]: 'de-la-ui' })

    repo.loadIntoProcess()

    expect(Bun.env[AMBIENT]).toBe('del-compose')
    expect(repo.get(AMBIENT)).toBe('de-la-ui') // la fila sigue ahí, esperando
    expect(repo.keysOverriddenByEnv()).toEqual([AMBIENT])
  })

  it('rellena lo que el ambiente no define', () => {
    const repo = setup({ [SAVED]: 'v' })

    repo.loadIntoProcess()

    expect(Bun.env[SAVED]).toBe('v')
    expect(repo.keysOverriddenByEnv()).toEqual([])
  })

  it('el ambiente que repite el MISMO valor no se reporta', () => {
    // Es la situación normal de un deploy: el compose trae lo mismo que quedó
    // guardado. Avisarlo sería ruido en toda la pantalla.
    ;(Bun.env as Record<string, string>)[AMBIENT] = 'igual'
    const repo = setup({ [AMBIENT]: 'igual' })

    repo.loadIntoProcess()

    expect(repo.keysOverriddenByEnv()).toEqual([])
  })

  it('guardar sobre una que define el ambiente escribe la fila pero NO aplica', () => {
    // El caso que la pantalla tiene que poder explicar: "guardé y no pasó
    // nada". La fila queda para el día que la variable salga del entorno.
    ;(Bun.env as Record<string, string>)[AMBIENT] = 'del-compose'
    const repo = setup()
    repo.loadIntoProcess()

    repo.set(AMBIENT, 'de-la-ui')

    expect(Bun.env[AMBIENT]).toBe('del-compose')
    expect(repo.get(AMBIENT)).toBe('de-la-ui')
    expect(repo.keysOverriddenByEnv()).toEqual([AMBIENT])
  })

  it('guardar una que el ambiente no define aplica al toque', () => {
    const repo = setup()
    repo.loadIntoProcess()

    repo.set(SAVED, 'v1')
    expect(Bun.env[SAVED]).toBe('v1')

    repo.set(SAVED, 'v2')
    expect(Bun.env[SAVED]).toBe('v2')
    expect(repo.keysOverriddenByEnv()).toEqual([])
  })

  it('borrar una fila tapada por el ambiente no toca el proceso', () => {
    ;(Bun.env as Record<string, string>)[AMBIENT] = 'del-compose'
    const repo = setup({ [AMBIENT]: 'de-la-ui' })
    repo.loadIntoProcess()

    repo.delete(AMBIENT)

    expect(repo.get(AMBIENT)).toBeNull()
    expect(Bun.env[AMBIENT]).toBe('del-compose')
  })

  it('borrar una fila que SÍ estaba en uso la saca del proceso', () => {
    const repo = setup({ [SAVED]: 'v' })
    repo.loadIntoProcess()
    expect(Bun.env[SAVED]).toBe('v')

    repo.delete(SAVED)

    expect(Bun.env[SAVED]).toBeUndefined()
  })

  it('vaciar una que sólo venía del ambiente no la destruye', () => {
    // La web renderiza pre-cargada una no-secreta aunque venga del compose, y
    // vaciarla manda `''` → `delete`. Eso no puede borrar el valor del deploy.
    ;(Bun.env as Record<string, string>)[AMBIENT] = 'del-compose'
    const repo = setup()
    repo.loadIntoProcess()

    repo.delete(AMBIENT)

    expect(Bun.env[AMBIENT]).toBe('del-compose')
  })

  it('una fila tapada vuelve a aplicar si el ambiente deja de definirla', () => {
    // El sentido de guardar igual: la fila no es basura, es lo que va a valer
    // el día que saquen la variable del compose.
    ;(Bun.env as Record<string, string>)[AMBIENT] = 'del-compose'
    const first = setup({ [AMBIENT]: 'de-la-ui' })
    first.loadIntoProcess()
    expect(Bun.env[AMBIENT]).toBe('del-compose')

    // Próximo arranque, ya sin la variable en el entorno.
    clearEnv()
    const second = setup({ [AMBIENT]: 'de-la-ui' })
    second.loadIntoProcess()

    expect(Bun.env[AMBIENT]).toBe('de-la-ui')
    expect(second.keysOverriddenByEnv()).toEqual([])
  })
})
