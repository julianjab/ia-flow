import type { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Migration } from './runner.js'

const PROMPTS_DIR = join(import.meta.dir, '028-prompts')

function loadPrompt(name: string): string {
  return readFileSync(join(PROMPTS_DIR, `${name}.md`), 'utf8')
}

const IA_FLOW_IN_PROGRESS_AGENTS = JSON.stringify([
  { agent: 'implementer', onFinish: '$set:Status=Review', onError: '$set:Status=Blocked' },
])

const IA_FLOW_BUILD_AGENTS = JSON.stringify([
  {
    agent: 'ia-flow-implementer-api',
    onFinish: '$set:Status=Review',
    onError: '$set:Status=Blocked',
  },
])

const IA_FLOW_TESTS_AGENTS = JSON.stringify([])

const LH116_IN_REVIEW_AGENTS = JSON.stringify([
  {
    agent: 'lh116-reviewer',
    onFinish: '$set:Status=Reviewed',
    onError: '$set:Status=Blocked',
  },
])

const AGENTS_TO_DELETE = [
  'ia-flow-verifier',
  'lh116-tester-frontend',
  'lh116-tester-backend-python',
  'lh116-tester-backend-ruby',
]

const PROMPT_UPDATES: Array<{ id: string; file: string }> = [
  { id: 'ia-flow-implementer', file: 'ia-flow-implementer' },
  { id: 'ia-flow-implementer-api', file: 'ia-flow-implementer-api' },
  { id: 'ia-flow-reviewer', file: 'ia-flow-reviewer' },
  { id: 'lh116-implementer', file: 'lh116-implementer' },
  { id: 'lh116-reviewer', file: 'lh116-reviewer' },
]

const migration: Migration = {
  id: '028-implementer-push-remove-testers',
  description:
    'Implementers ahora escriben tests, commitean y pushean. Elimina testers (lh116-*) y verifier (ia-flow), fusiona su rol en el reviewer. Reescribe prompts y actualiza statuses.',
  up(db: Database): void {
    for (const { id, file } of PROMPT_UPDATES) {
      const row = db.query('SELECT id FROM agents WHERE id = ?').get(id)
      if (!row) continue
      db.run('UPDATE agents SET prompt = ? WHERE id = ?', [loadPrompt(file), id])
    }

    for (const id of AGENTS_TO_DELETE) {
      db.run('DELETE FROM agents WHERE id = ?', [id])
    }

    db.run("UPDATE statuses SET agents = ? WHERE project_id = 'ia-flow' AND name = 'In Progress'", [
      IA_FLOW_IN_PROGRESS_AGENTS,
    ])
    db.run("UPDATE statuses SET agents = ? WHERE project_id = 'ia-flow' AND name = 'Build'", [
      IA_FLOW_BUILD_AGENTS,
    ])
    db.run("UPDATE statuses SET agents = ? WHERE project_id = 'ia-flow' AND name = 'Tests'", [
      IA_FLOW_TESTS_AGENTS,
    ])
    db.run(
      "UPDATE statuses SET agents = ? WHERE project_id = 'la-haus-116' AND name = 'In Review'",
      [LH116_IN_REVIEW_AGENTS],
    )
  },
}

export default migration
