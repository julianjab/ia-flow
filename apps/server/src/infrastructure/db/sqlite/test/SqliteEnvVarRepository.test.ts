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

  it('anota la clave cuando el boot pisa un valor del ambiente', () => {
    // El caso central: el proceso arranca con el valor del shell/compose y
    // `loadIntoProcess` lo tapa con el guardado.
    ;(Bun.env as Record<string, string>)[AMBIENT] = 'del-shell'
    const { repo: r, db } = setup()
    db.run(`INSERT INTO global_settings (key, value) VALUES (?, ?)`, [`env.${AMBIENT}`, 'de-la-ui'])
    r.loadIntoProcess()

    expect(r.shadowedEnvKeys()).toEqual([AMBIENT])
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
    expect(Bun.env[AMBIENT]).toBe('de-la-ui')
  })

  it('re-guardar una que nunca estuvo en el ambiente NO inventa un override', () => {
    // El caso que rompía: al segundo guardado `Bun.env` ya tiene el valor que
    // este mismo repositorio escribió en el primero, así que compararlo contra
    // el nuevo da "distinto" y la pantalla avisaba de un entorno inexistente.
    repo.set(SAVED, 'v1')
    repo.set(SAVED, 'v2')

    expect(repo.shadowedEnvKeys()).toEqual([])
    expect(Bun.env[SAVED]).toBe('v2')
  })

  it('editar una que sí tapaba al ambiente lo sigue reportando una sola vez', () => {
    ;(Bun.env as Record<string, string>)[AMBIENT] = 'del-shell'
    repo.set(AMBIENT, 'v1')
    repo.set(AMBIENT, 'v2')

    expect(repo.shadowedEnvKeys()).toEqual([AMBIENT])
  })

  it('borrar la fila RESTITUYE el valor del ambiente en el proceso', () => {
    // No alcanza con dejar de reportarlo: si el valor del shell/compose no
    // vuelve, la variable queda sin ninguno hasta reiniciar mientras la
    // pantalla dice "no configurada" aunque el deploy sí la traiga.
    ;(Bun.env as Record<string, string>)[AMBIENT] = 'del-shell'
    repo.set(AMBIENT, 'de-la-ui')
    repo.delete(AMBIENT)

    expect(repo.shadowedEnvKeys()).toEqual([])
    expect(repo.get(AMBIENT)).toBeNull()
    expect(Bun.env[AMBIENT]).toBe('del-shell')
  })

  it('el ambiente IGUAL no ensucia el cartel, pero igual se restituye al borrar', () => {
    // Los dos trabajos del mapa, que confundirlos rompía: un compose que
    // repite el token ya guardado no es un override que mostrar, pero SÍ es un
    // valor que tiene que volver si alguien limpia el campo desde la pantalla.
    ;(Bun.env as Record<string, string>)[AMBIENT] = 'igual'
    const { repo: r, db } = setup()
    db.run(`INSERT INTO global_settings (key, value) VALUES (?, ?)`, [`env.${AMBIENT}`, 'igual'])
    r.loadIntoProcess()
    expect(r.shadowedEnvKeys()).toEqual([])

    r.delete(AMBIENT)
    expect(Bun.env[AMBIENT]).toBe('igual')
  })

  it('editar una que tapaba un valor idéntico empieza a reportarse', () => {
    // Corolario del anterior: el cartel se deriva comparando contra la fila,
    // así que cambiar el valor guardado lo enciende sin tocar nada más.
    ;(Bun.env as Record<string, string>)[AMBIENT] = 'igual'
    const { repo: r, db } = setup()
    db.run(`INSERT INTO global_settings (key, value) VALUES (?, ?)`, [`env.${AMBIENT}`, 'igual'])
    r.loadIntoProcess()

    r.set(AMBIENT, 'otro')
    expect(r.shadowedEnvKeys()).toEqual([AMBIENT])
  })

  it('borrar una que no tapaba nada la saca del proceso', () => {
    repo.set(SAVED, 'v')
    repo.delete(SAVED)

    expect(Bun.env[SAVED]).toBeUndefined()
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
