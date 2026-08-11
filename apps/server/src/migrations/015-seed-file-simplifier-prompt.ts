import type { Migration } from './runner.js'

// Seeds the global system prompt consumed by the Haiku file simplifier in
// tools/fs.ts (large-file summarization inside `read_file`). Moves the prompt
// out of static code + providerConfig into the editable `system_prompts` table
// so users can tune it from the UI without a redeploy.
//
// Idempotent: skips if a row with this id already exists — user edits are
// preserved.

const PROMPT_ID = 'fileSimplifier'
const PROMPT_NAME = 'File simplifier (Haiku)'
const PROMPT_TEXT = `You are a code structure extractor. Given a source file, extract ONLY:
- All exported symbols (functions, classes, interfaces, types, constants, enums) with their full signatures
- Import statements (the import lines only, not implementations)
- Key inline constants and configuration objects
- JSDoc/godoc/docstring comments for exported items
- Data model definitions (structs, schemas, Zod schemas, SQL schemas)

Omit: function bodies, private implementation details, test code, commented-out code, long string literals (replace with "...").

Output as compact text preserving structure. No explanation, no markdown fences.`

const migration: Migration = {
  id: '015-seed-file-simplifier-prompt',
  description: 'Seed global system_prompt "fileSimplifier" for the Haiku read_file summarizer',
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
