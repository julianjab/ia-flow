import type { Database } from 'bun:sqlite'
import type { Migration } from './runner.js'

const IMPLEMENTER_PROMPT = `Implement this GitHub issue: {{task.title}}

**Task ID:** {{task.id}}

## PRD

{{task.description}}

## Repos

{{context.repos}}

## Rules

1. Read the PRD above — it contains the full spec, acceptance criteria, and technical details.
2. Read CLAUDE.md before anything else and follow its conventions strictly.
3. Use sub-agents and skills in .claude/ where appropriate.
4. Run lint and tests before committing.
5. Commit with a conventional commit message referencing the issue.
6. Create a pull request when done.

## Progress tracking

After completing each user story or acceptance criterion, call \`update_issue_body\` with \`task_id\` = \`{{task.id}}\` and the full updated PRD markdown, marking the completed item with ✅.

When fully done, call \`complete_task\` with \`task_id\` = \`{{task.id}}\` and a summary including the PR URL.
If you cannot complete the task, call \`fail_task\` with \`task_id\` = \`{{task.id}}\` and a description of what blocked you.`

const migration: Migration = {
  id: '006-implementer-progress-updates',
  description: 'Agrega update_issue_body al implementer para tracking de progreso durante la implementación',
  up(db: Database): void {
    const hasImplementer = db.query("SELECT id FROM agents WHERE id = 'implementer'").get()
    if (hasImplementer) {
      db.run(
        `UPDATE agents SET prompt = ?, tools = ? WHERE id = 'implementer'`,
        [IMPLEMENTER_PROMPT, JSON.stringify(['update_issue_body', 'complete_task', 'fail_task'])],
      )
    }
  },
}

export default migration
