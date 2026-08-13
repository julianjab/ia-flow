import type { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Migration } from './runner.js'

const PROMPTS_DIR = join(import.meta.dir, '032-prompts')

function loadPrompt(name: string): string {
  return readFileSync(join(PROMPTS_DIR, `${name}.md`), 'utf8')
}

const migration: Migration = {
  id: '032-ia-flow-reviewer-no-pr-direct-merge',
  description:
    'ia-flow-reviewer: elimina modo trunk y PR intermedio. Al aprobar, mergea `{{task.branch}}` a `main` fast-forward y pushea. Sin `gh pr create` ni `gh pr merge`.',
  up(db: Database): void {
    const row = db.query('SELECT id FROM agents WHERE id = ?').get('ia-flow-reviewer')
    if (!row) return
    db.run('UPDATE agents SET prompt = ? WHERE id = ?', [
      loadPrompt('ia-flow-reviewer'),
      'ia-flow-reviewer',
    ])
  },
}

export default migration
