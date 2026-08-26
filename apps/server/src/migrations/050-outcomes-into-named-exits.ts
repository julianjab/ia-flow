import type { Migration } from './runner.js'

// `on_finish` / `on_error` → `exits`, un mapa `{nombre: '$set:...'}`.
//
// Un run termina aplicando UNA transición, y esas dos columnas ya eran dos
// salidas con nombre hardcodeado: el engine elegía entre ellas según cómo
// terminó el run. Nombrarlas explícitamente quita un caso especial y deja
// declarar salidas ADICIONALES que el agente puede pedir por nombre — el caso
// que lo motivó es un refiner que descubre que el PRD está bien y lo que falla
// es la implementación: necesita devolver el issue al builder, no mandarlo a
// `blocked`, y con dos slots fijos eso no se podía expresar.
//
// `success` y `error` quedan como nombres reservados con exactamente el valor
// que tenían `on_finish` y `on_error`, así que ningún agente cambia de
// comportamiento: el default sigue eligiéndose igual y nadie declara salidas
// nuevas hasta que un humano las agregue.
//
// Es el mismo movimiento que la 039 (`$labels:` → `$set:`): dos canales para
// un concepto se colapsan en uno. La alternativa —dejar `exits` AL LADO de
// `on_finish`/`on_error`— habría repetido justo el problema que aquella vino a
// arreglar.
//
// Las dos tablas la llevan: `agents` es la declaración, y `execution_logs` la
// copia al arrancar el run (contrato de cierre de la 048) para que un cierre
// tardío pueda transicionar aunque el registry en memoria ya no exista.
//
// Idempotente: si `exits` ya está, no hace nada.
const migration: Migration = {
  id: '050-outcomes-into-named-exits',
  description: 'Collapse on_finish/on_error into a named `exits` map on agents and execution_logs',
  up(db) {
    for (const table of ['agents', 'execution_logs']) {
      const columns = db.query(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{
        name: string
      }>
      const names = new Set(columns.map((c) => c.name))
      if (!names.has('exits')) {
        db.run(`ALTER TABLE ${table} ADD COLUMN exits TEXT`)
      }
      // Sin las columnas viejas no hay nada que convertir (DB nueva).
      if (!names.has('on_finish') && !names.has('on_error')) continue

      // `json_object` omite nada: se arma a mano para que una salida sin valor
      // no quede como `{"success": null}` — un agente sin transición declarada
      // tiene que seguir sin transición, no con una vacía.
      const rows = db
        .query(
          `SELECT id, on_finish, on_error FROM ${table}
           WHERE exits IS NULL AND (on_finish IS NOT NULL OR on_error IS NOT NULL)`,
        )
        .all() as Array<{ id: string; on_finish: string | null; on_error: string | null }>
      const update = db.prepare(`UPDATE ${table} SET exits = ? WHERE id = ?`)
      for (const row of rows) {
        const exits: Record<string, string> = {}
        if (row.on_finish) exits.success = row.on_finish
        if (row.on_error) exits.error = row.on_error
        update.run(JSON.stringify(exits), row.id)
      }
    }

    // Las columnas viejas se dejan en su lugar a propósito: SQLite no tiene
    // DROP COLUMN antes de 3.35 y, más importante, dejarlas hace que un
    // rollback del binario no pierda los datos. Nadie las lee ya.
  },
}

export default migration
