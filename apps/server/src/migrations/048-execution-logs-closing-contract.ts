import type { Migration } from './runner.js'

// Lo que hace falta para cerrar un run SIN el registry en memoria.
//
// Hasta acá, la entrada de una tarea en vuelo vivía sólo en un `Map` del
// proceso (packages/agent-engine/src/pending-tasks.ts). Si ese proceso
// reiniciaba —o si el watchdog borraba la entrada por una lectura de liveness
// equivocada— la sesión del agente seguía viva pero se quedaba sin nadie que
// le recibiera el `complete_task`: el trabajo estaba hecho (commits, PR) y el
// issue quedaba mudo, sin transición y sin comentario.
//
// Con estas tres columnas, la fila de `execution_logs` alcanza para
// reconstruir esa entrada: el `manager` sale de `project_id`, el `task` se
// relee del source, y acá quedan los tres datos que NO se pueden re-derivar
// con seguridad después:
//
//  - `initial_status`: el status con el que arrancó el run. Es contra esto
//    que `complete_task` decide si el prompt ya movió la tarea por su cuenta
//    (`statusChangedByPrompt`) y hay que respetar ese movimiento en vez de
//    pisarlo con el onFinish por defecto.
//  - `on_finish` / `on_error`: la transición que el run PACTÓ al arrancar.
//    Se guardan en vez de releerlas del `AgentDefinition` porque el agente se
//    puede editar mientras el run corre (la UI lo permite, y los YAML de los
//    runners se recargan): al cerrar hay que aplicar lo que el run prometió,
//    no lo que el agente dice hoy.
//
// Todas nullable: las filas previas a esta migración no las tienen y el
// camino de cierre cae al comportamiento de antes cuando faltan.
//  - `finalized_by_tool`: quién cerró la fila. Hace falta porque `outcome`
//    no alcanza para distinguirlo: la barrida de huérfanos también escribía
//    `outcome = 'error'`, así que un run que el reinicio cerró era
//    indistinguible de uno que el agente cerró de verdad — y el cierre
//    tardío del agente se habría descartado como duplicado, que es
//    exactamente el caso que esto viene a arreglar.
const COLUMNS: Array<[name: string, type: string]> = [
  ['initial_status', 'TEXT'],
  ['on_finish', 'TEXT'],
  ['on_error', 'TEXT'],
  ['finalized_by_tool', 'INTEGER'],
]

const migration: Migration = {
  id: '048-execution-logs-closing-contract',
  description: 'Add initial_status / on_finish / on_error to execution_logs (durable run closing)',
  up(db) {
    const existing = new Set(
      (
        db.query(`SELECT name FROM pragma_table_info('execution_logs')`).all() as Array<{
          name: string
        }>
      ).map((r) => r.name),
    )
    for (const [name, type] of COLUMNS) {
      if (!existing.has(name)) db.run(`ALTER TABLE execution_logs ADD COLUMN ${name} ${type}`)
    }
    // El camino caliente nuevo: "¿hay un run abierto para esta task?", que
    // corre en cada tool de cierre y en la reconciliación de arranque.
    db.run(
      `CREATE INDEX IF NOT EXISTS idx_execution_logs_task_started ON execution_logs(task_id, started_at)`,
    )
  },
}

export default migration
