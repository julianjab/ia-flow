import type { Migration } from './runner.js'

// Seeds a global system prompt used by the "generate repo description"
// button in the projects → repos tab. The web calls
// `POST /api/repos/mappings/assist-description`, which loads this prompt
// from the DB, sends it as `system:` to Claude, and returns the model's
// output as the description candidate.
//
// The prompt is global (project_id = NULL) so every project can use it.
// Idempotent: skips if a row with this id already exists — user edits
// are preserved.

const PROMPT_ID = 'repoDescriptionAssistant'
const PROMPT_NAME = 'Repo description assistant'
const PROMPT_TEXT = `Eres un asistente que redacta descripciones muy breves de repositorios de código.

Del mensaje del usuario extrae el JSON con nombre del repo, path local (si existe) y owner/repo de GitHub (si existe). Ignora cualquier wrapper tipo "Agent ID:" o "Description of what this agent should do:" — solo te importa el JSON.

Tu respuesta debe:
- Ser una sola línea de texto plano (sin markdown, sin comillas, sin prefijos, sin "Aquí tienes…").
- No superar 120 caracteres.
- Explicar de forma clara y directa qué es el repo (stack + rol/propósito si se puede inferir del nombre o del path).
- Estar en español salvo que el nombre esté claramente en inglés.

Ejemplos de buen output:
- API en FastAPI que expone endpoints de suscripciones y cobranza.
- SPA Vue 3 del admin del chatbot de captación de leads.
- Infra: Terraform + workflows de GitHub Actions para despliegues productivos.

No repitas el nombre del repo al inicio si no aporta contexto. Solo devuelve la descripción.`

const migration: Migration = {
  id: '012-seed-repo-description-prompt',
  description:
    'Seed global system_prompt "repoDescriptionAssistant" for the repo description AI helper',
  up(db) {
    const existing = db
      .query('SELECT id FROM system_prompts WHERE id = ? LIMIT 1')
      .get(PROMPT_ID) as { id: string } | null
    if (existing) return

    // Next position among globals (project_id IS NULL) so it ends up last.
    const row = db
      .query(
        'SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM system_prompts WHERE project_id IS NULL',
      )
      .get() as { pos: number }

    db.run(
      `INSERT INTO system_prompts (id, name, text, position, project_id)
       VALUES (?, ?, ?, ?, NULL)`,
      [PROMPT_ID, PROMPT_NAME, PROMPT_TEXT, row.pos],
    )
  },
}

export default migration
