import type { Migration } from './runner.js'

// Acciones con nombre propio.
//
// Hasta acá una acción sólo existía dentro del `do[]` de una regla, así que tres
// reglas que llaman a la misma API tenían la URL escrita tres veces — y
// cambiarla eran tres ediciones, con la variante que se olvida.
//
// Sólo ESTRUCTURA: la tabla nace vacía. No se siembra ninguna acción, por la
// misma razón que no se siembran reglas ni agentes (ver la regla de migraciones
// en el CLAUDE.md de la raíz): las escribe el operador desde la UI o vienen en
// el YAML de un deploy, así que sembrarlas haría que actualizar el producto
// pise lo que alguien editó.
//
// `project_id` NULL = global, misma semántica que en `rules` y en `agents`. Es
// una referencia lógica y no una FK, igual que allá: validarla es trabajo del
// CRUD, que puede dar un error legible en vez de un `FOREIGN KEY constraint
// failed`.
//
// `body` es JSON y no se normaliza a columnas por tipo de acción: cada kind
// tiene su forma (`agentId`, `url`+`method`+`body`, `type`+`payload`), se lee y
// se escribe siempre entero, y una tabla por variante sólo agregaría joins.

const migration: Migration = {
  id: '063-named-actions',
  description: 'Create the actions table',
  up(db) {
    db.run(`
      CREATE TABLE IF NOT EXISTS actions (
        id          TEXT PRIMARY KEY NOT NULL,
        name        TEXT,
        description TEXT,
        project_id  TEXT,
        body        TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      )
    `)
    // El acceso más común es "las visibles en este ámbito": las del proyecto
    // más las globales, que caen en el mismo árbol con project_id NULL.
    db.run(`
      CREATE INDEX IF NOT EXISTS idx_actions_scope
        ON actions(project_id, id)
    `)
  },
}

export default migration
