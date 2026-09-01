import type { Migration } from './runner.js'

// Absorbe la activación de cada agente en una fila de `rules`, y le saca a
// `agents` las columnas que la expresaban.
//
// Esto NO es sembrar config: las filas que se crean son las que el operador ya
// había configurado, movidas de lugar. Transformar datos que ya están es
// exactamente el trabajo de una migración — lo que la regla del CLAUDE.md
// prohíbe es hacer NACER config de un release, que es otra cosa.
//
// La regla equivalente a una activación es:
//
//   on: ['issue.created', 'issue.status_changed']  ← lo que publica el scan
//                                                     cuando algo cambió
//   projectId / repoName               ← tal cual venían
//   when: [statusName] + when_conditions ← el status pasa a ser una condición más
//   whenText, enabled                  ← tal cual
//   exclusive: true                    ← ver abajo
//   do: [{ action: 'agent', agentId }]
//
// **`exclusive: true` no es opcional acá.** `selectAgent` corría UN agente por
// dispatch —el primero por especificidad y posición—; `matchRules` dispara
// TODAS las que matchean. Sin `exclusive`, un roster con dos agentes que hoy
// compiten por el mismo status pasaría a lanzarlos a los dos sobre la misma
// task. Preservar el comportamiento exige el corte.
//
// El `statusName` se convierte en una condición `status = X` en vez de un campo
// propio: en el modelo de reglas el status es un campo más del payload, y
// tratarlo aparte habría obligado al matcher a conocerlo.

interface AgentRow {
  id: string
  project_id: string | null
  repo_name: string | null
  status_name: string | null
  when_conditions: string | null
  when_text: string | null
  enabled: number
  position: number
}

interface WhenCondition {
  field: string
  op: string
  value?: string
  logic?: string
}

const migration: Migration = {
  id: '059-activation-into-rules',
  description: 'Move agent activation criteria into rules rows; drop them from agents',
  up(db) {
    const agents = db
      .query(
        `SELECT id, project_id, repo_name, status_name, when_conditions, when_text, enabled, position
         FROM agents`,
      )
      .all() as AgentRow[]

    const now = new Date().toISOString()

    for (const a of agents) {
      // Un agente sin `statusName` NI `when` nunca fue despachable: es
      // justamente lo que el filtro `isScoped` de agent-selection.ts descarta
      // (sin criterios que dejen de cumplirse, se re-ejecutaría en loop). No
      // tiene activación que migrar.
      const existing = a.when_conditions
        ? (JSON.parse(a.when_conditions) as WhenCondition[] | Record<string, string>)
        : null
      const hasWhen = Array.isArray(existing)
        ? existing.length > 0
        : existing != null && Object.keys(existing).length > 0
      if (!a.status_name && !hasWhen) continue

      // El formato Record legacy se normaliza al de array acá: la regla nace
      // con una sola forma, y así el editor no tiene que soportar las dos.
      const conditions: WhenCondition[] = []
      if (a.status_name) conditions.push({ field: 'status', op: '=', value: a.status_name })
      if (Array.isArray(existing)) {
        conditions.push(...existing)
      } else if (existing) {
        for (const [field, raw] of Object.entries(existing)) {
          if (raw === '$null' || raw === '$not_null') conditions.push({ field, op: raw })
          else if (raw.startsWith('$ne:')) conditions.push({ field, op: '!=', value: raw.slice(4) })
          else conditions.push({ field, op: '=', value: raw })
        }
      }
      // El `logic` de la primera condición no significa nada (es el conector
      // con la anterior); si el status quedó adelante, hay que correrlo.
      for (const [i, c] of conditions.entries()) {
        if (i === 0) c.logic = undefined
        else c.logic = c.logic ?? 'and'
      }

      db.run(
        `INSERT INTO rules (
           id, name, description, on_types, project_id, repo_name,
           when_conditions, when_text, enabled, position, exclusive, actions,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        [
          `agent-${a.id}`,
          `Activación de ${a.id}`,
          'Migrada desde la activación del agente (migración 059)',
          JSON.stringify(['issue.created', 'issue.status_changed']),
          a.project_id,
          a.repo_name,
          JSON.stringify(conditions),
          a.when_text,
          a.enabled,
          a.position,
          JSON.stringify([{ action: 'agent', agentId: a.id }]),
          now,
          now,
        ],
      )
    }

    // SQLite no tiene DROP COLUMN en versiones viejas, y el resto de las
    // migraciones de este repo recrean la tabla — se sigue el mismo patrón
    // para no depender de la versión del binario.
    db.run(`
      CREATE TABLE agents_new (
        id                        TEXT PRIMARY KEY NOT NULL,
        position                  INTEGER NOT NULL DEFAULT 0,
        provider                  TEXT NOT NULL,
        prompt                    TEXT NOT NULL,
        variables                 TEXT,
        tools                     TEXT,
        save_output               INTEGER,
        system_prompts            TEXT,
        project_id                TEXT REFERENCES projects(id),
        provider_config           TEXT,
        mcp_catalog_ids           TEXT,
        requires_branch           INTEGER,
        max_concurrent_dispatches INTEGER,
        allow_blocked             INTEGER NOT NULL DEFAULT 0,
        on_process                TEXT,
        exits                     TEXT,
        comment                   TEXT
      )
    `)
    db.run(`
      INSERT INTO agents_new (
        id, position, provider, prompt, variables, tools, save_output,
        system_prompts, project_id, provider_config, mcp_catalog_ids,
        requires_branch, max_concurrent_dispatches, allow_blocked, on_process,
        exits, comment
      )
      SELECT
        id, position, provider, prompt, variables, tools, save_output,
        system_prompts, project_id, provider_config, mcp_catalog_ids,
        requires_branch, max_concurrent_dispatches, allow_blocked, on_process,
        exits, comment
      FROM agents
    `)
    db.run('DROP TABLE agents')
    db.run('ALTER TABLE agents_new RENAME TO agents')
  },
}

export default migration
