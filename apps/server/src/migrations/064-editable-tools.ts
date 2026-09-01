import type { Migration } from './runner.js'

// Tools editables: las definidas por config y los ajustes sobre las built-in.
//
// Una sola tabla con `kind` explícito, porque las dos cosas comparten identidad
// (el nombre) y el límite entre ellas es una regla, no un esquema: una
// `override` sólo puede tocar la descripción. Separarlas en dos tablas
// duplicaría el índice único por nombre —que es lo que impide que una definida
// tape a una built-in— y dejaría esa invariante repartida.
//
// Sólo ESTRUCTURA, como el resto: nace vacía. No se siembra ninguna tool ni
// ninguna override; sembrar descripciones haría que actualizar el producto pise
// el tuning que alguien hizo (ver la regla de migraciones del CLAUDE.md raíz).
//
// `name` es PRIMARY KEY y NO hay `(name, project_id)`: el nombre de una tool es
// global. Es lo que un agente escribe en su `tools[]`, y `ProviderInput.tools`
// viaja como nombres hasta el provider, que los resuelve contra un registry
// único del proceso. Ver el comentario de `ToolNameSchema`.

const migration: Migration = {
  id: '064-editable-tools',
  description: 'Create the tools table (defined tools + built-in overrides)',
  up(db) {
    db.run(`
      CREATE TABLE IF NOT EXISTS tools (
        name         TEXT PRIMARY KEY NOT NULL,
        kind         TEXT NOT NULL CHECK (kind IN ('defined', 'override')),
        description  TEXT NOT NULL,
        input_schema TEXT,
        action_id    TEXT,
        project_id   TEXT,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      )
    `)
    // Una `defined` sin acción no tiene qué ejecutar, y una `override` con
    // acción estaría fingiendo que cambia el comportamiento de una built-in
    // —que es justo lo que no puede hacer—. Se chequea en la base y no sólo en
    // el CRUD porque es una invariante del dato, no de la ruta.
    db.run(`
      CREATE TRIGGER IF NOT EXISTS tools_kind_consistency
      BEFORE INSERT ON tools
      BEGIN
        SELECT CASE
          WHEN NEW.kind = 'defined' AND (NEW.action_id IS NULL OR NEW.action_id = '')
            THEN RAISE(ABORT, 'una tool definida necesita action_id')
          WHEN NEW.kind = 'override' AND NEW.action_id IS NOT NULL
            THEN RAISE(ABORT, 'una override no puede tener action_id')
        END;
      END
    `)
  },
}

export default migration
