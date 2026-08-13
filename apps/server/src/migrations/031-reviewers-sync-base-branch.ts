import type { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Migration } from './runner.js'

const PROMPTS_DIR = join(import.meta.dir, '031-prompts')

function loadPrompt(name: string): string {
  return readFileSync(join(PROMPTS_DIR, `${name}.md`), 'utf8')
}

const PROMPT_UPDATES: Array<{ id: string; file: string }> = [
  { id: 'ia-flow-reviewer', file: 'ia-flow-reviewer' },
  { id: 'lh116-reviewer', file: 'lh116-reviewer' },
]

const migration: Migration = {
  id: '031-reviewers-sync-base-branch',
  description:
    'Reviewers ahora integran `origin/<base>` en la rama de trabajo antes de correr checks. Conflictos triviales los resuelven ellos; conflictos que tocan código de la tarea → fail_task a Build.',
  up(db: Database): void {
    for (const { id, file } of PROMPT_UPDATES) {
      const row = db.query('SELECT id FROM agents WHERE id = ?').get(id)
      if (!row) continue
      db.run('UPDATE agents SET prompt = ? WHERE id = ?', [loadPrompt(file), id])
    }
  },
}

export default migration
