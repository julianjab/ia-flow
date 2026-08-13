import type { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Migration } from './runner.js'

// The ia-flow GitHub Project (user julianjab #2) exposes only these Status
// options: Blocked, Todo, Refine, Build, Tests, Done. Migration 028 wrote
// `Status=Review`, which does not exist in GitHub — this migration realigns
// the workflow so the reviewer runs in `Tests` and closes to `Done`.

const IA_FLOW_IN_PROGRESS_AGENTS = JSON.stringify([
  { agent: 'implementer', onFinish: '$set:Status=Tests', onError: '$set:Status=Blocked' },
])

const IA_FLOW_BUILD_AGENTS = JSON.stringify([
  {
    agent: 'ia-flow-implementer-api',
    onFinish: '$set:Status=Tests',
    onError: '$set:Status=Blocked',
  },
])

const IA_FLOW_TESTS_AGENTS = JSON.stringify([
  {
    agent: 'ia-flow-reviewer',
    onFinish: '$set:Status=Done',
    onError: '$set:Status=Build',
  },
])

const migration: Migration = {
  id: '029-ia-flow-status-alignment',
  description:
    'Alinea el flujo de ia-flow con los statuses reales del ProjectV2 (Review no existe en GitHub). Build/In Progress -> Tests; reviewer corre en Tests -> Done.',
  up(db: Database): void {
    db.run("UPDATE statuses SET agents = ? WHERE project_id = 'ia-flow' AND name = 'In Progress'", [
      IA_FLOW_IN_PROGRESS_AGENTS,
    ])
    db.run("UPDATE statuses SET agents = ? WHERE project_id = 'ia-flow' AND name = 'Build'", [
      IA_FLOW_BUILD_AGENTS,
    ])
    db.run("UPDATE statuses SET agents = ? WHERE project_id = 'ia-flow' AND name = 'Tests'", [
      IA_FLOW_TESTS_AGENTS,
    ])

    // Refresh reviewer prompt (updated to state it runs in status `Tests`).
    const reviewerPrompt = readFileSync(
      join(import.meta.dir, '028-prompts', 'ia-flow-reviewer.md'),
      'utf8',
    )
    const hasReviewer = db.query("SELECT id FROM agents WHERE id = 'ia-flow-reviewer'").get()
    if (hasReviewer) {
      db.run('UPDATE agents SET prompt = ? WHERE id = ?', [reviewerPrompt, 'ia-flow-reviewer'])
    }
  },
}

export default migration
