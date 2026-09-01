import type { Migration } from './runner.js'

// El estado de trabajo de un run en vuelo: dónde iba, para no perderlo.
//
// Es una tabla propia y NO un campo de `execution_logs`, por tres razones que
// no son de estilo:
//
//  - `CompositeExecutionLogRepository.update()` hace fan-out a los repos
//    remotos, que son forwards HTTP write-only. Como columna, cada vuelta del
//    loop POSTearía la conversación entera por la red.
//  - `SqliteExecutionLogRepository` lee con `SELECT *` (listado, listActive y
//    el fetch por ids), así que el blob se traería en cada carga de la
//    pantalla de Ejecuciones, para un campo que esa pantalla no muestra.
//  - `ExecutionLog` es un schema de `@ia-flow/shared` que cruza al front. El
//    estado interno del engine no tiene por qué viajar en ese contrato.
//
// Y sobre todo tienen CICLOS DE VIDA distintos: la fila de `execution_logs` es
// historia y vive para siempre; el checkpoint es basura en cuanto el run
// termina, y se borra. Mismo criterio por el que `waits` y `run_messages`
// nacieron separadas aunque compartan migración.
//
// `run_id` es PRIMARY KEY y la fila se PISA: sólo interesa el último request
// enviado, no un historial de versiones. Sin esto la tabla crecería con la
// conversación entera por cada turno de cada run.
//
// `state` es un blob opaco: lo produce y lo interpreta el PROVIDER, igual que
// el `checkpoint` de `ProviderOutput` que ya estaba documentado así. El engine
// sólo lo guarda y se lo devuelve — para `anthropic-api` es el array de
// mensajes; un provider de terminal no lo usa (su proceso sobrevive solo, y
// para eso está `pending-task-rehydrator`).
//
// Sólo estructura: nace vacía. Sin FKs, igual que `waits` y `agent_memories`.

const migration: Migration = {
  id: '066-run-checkpoints',
  description: 'Create run_checkpoints (last provider state of an in-flight run)',
  up(db) {
    db.run(`
      CREATE TABLE IF NOT EXISTS run_checkpoints (
        run_id     TEXT PRIMARY KEY NOT NULL,
        task_id    TEXT NOT NULL,
        agent_id   TEXT,
        project_id TEXT,
        state      TEXT NOT NULL,
        attempts   INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      )
    `)
    // La otra lectura, además de la que va por `run_id`: "¿qué checkpoint dejó
    // esta task?" — es la que usa el resume, que conoce la task (viene de la
    // espera) pero no el run que la dejó.
    db.run('CREATE INDEX IF NOT EXISTS idx_run_checkpoints_task ON run_checkpoints(task_id)')
  },
}

export default migration
