import type { Migration } from './runner.js'

// Task-scoped tools were extracted from the GitHub-only tools file and now
// route through ITransitionManager so they work for any source. Old names
// (add_issue_comment, set_project_field, add_issue_labels) are renamed to
// their agnostic equivalents everywhere they appear:
//   · agents.prompt          — free-form markdown mentioning the tool by name
//   · agents.tools           — JSON array of tool names the agent may call
//   · system_prompts.text    — some seed prompts document the tool set
const RENAMES: Record<string, string> = {
  add_issue_comment: 'add_task_comment',
  set_project_field: 'set_task_field',
  add_issue_labels: 'set_task_labels',
}

function rewrite(text: string): string {
  let out = text
  for (const [oldName, newName] of Object.entries(RENAMES)) {
    out = out.replaceAll(oldName, newName)
  }
  return out
}

function rewriteToolsJson(raw: string | null): string | null {
  if (raw == null) return raw
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return raw
    const remapped = parsed.map((t) => (typeof t === 'string' ? (RENAMES[t] ?? t) : t))
    return JSON.stringify(remapped)
  } catch {
    return raw
  }
}

const migration: Migration = {
  id: '010-rename-task-scoped-tools',
  description:
    'Rename task-scoped tools (add_issue_comment/set_project_field/add_issue_labels) to their source-agnostic names',
  up(db) {
    const agents = db.query('SELECT id, prompt, tools FROM agents').all() as {
      id: string
      prompt: string
      tools: string | null
    }[]
    for (const a of agents) {
      const nextPrompt = rewrite(a.prompt)
      const nextTools = rewriteToolsJson(a.tools)
      if (nextPrompt !== a.prompt || nextTools !== a.tools) {
        db.run('UPDATE agents SET prompt = ?, tools = ? WHERE id = ?', [
          nextPrompt,
          nextTools,
          a.id,
        ])
      }
    }

    const prompts = db.query('SELECT id, text FROM system_prompts').all() as {
      id: string
      text: string
    }[]
    for (const p of prompts) {
      const next = rewrite(p.text)
      if (next !== p.text) {
        db.run('UPDATE system_prompts SET text = ? WHERE id = ?', [next, p.id])
      }
    }
  },
}

export default migration
