import type { Migration } from './runner.js'

// Seeds the global system prompt consumed by the Haiku history-compaction
// helper in tools/index.ts. Moves the prompt out of static code + providerConfig
// into the editable `system_prompts` table so users can tune it from the UI
// without a redeploy.
//
// Idempotent: skips if a row with this id already exists — user edits are
// preserved.

const PROMPT_ID = 'historyCompaction'
const PROMPT_NAME = 'History compaction (Haiku)'
const PROMPT_TEXT = `Summarize the key technical findings from these code exploration tool results.
Focus on: what files exist and their purpose, API contracts found, data models, key function signatures, important patterns.
Be specific and concrete — include actual names, types, paths.
Output as a concise "Key findings:" section. No preamble, no explanation.`

const migration: Migration = {
  id: '016-seed-history-compaction-prompt',
  description: 'Seed global system_prompt "historyCompaction" for the Haiku agent-loop compactor',
  up(db) {
    const existing = db
      .query('SELECT id FROM system_prompts WHERE id = ? LIMIT 1')
      .get(PROMPT_ID) as { id: string } | null
    if (existing) return

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
