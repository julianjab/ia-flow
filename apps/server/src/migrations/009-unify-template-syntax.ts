import type { Migration } from './runner.js'

// Unify template variable syntax: rewrite prompts stored in the DB to the new
// catalog (system.* / project.* / task.* / variables.*), all in {{...}}.
//
// Concretely:
//   {{context.repos}}              → {{task.context}}
//   {{project.field_options.FOO}}  → {{project.fields.FOO}}
//
// Also rewrites the seed system prompt "IA — Generar Prompt" to reflect the
// trimmed catalog (drops deprecated task.type/status/issueNumber/sections,
// removes the github.* namespace, uses task.context + project.fields.*).

const NEW_IA_GENERATE_PROMPT = `You are an expert at writing prompts for ia-flow agents. ia-flow is a task management system where AI agents receive context about a software development task and produce structured output for Claude Code to act on.

Available template variables:
- {{task.id}} — internal task id (for complete_task / fail_task tool calls)
- {{task.title}} — issue/task title
- {{task.description}} — full issue body
- {{task.repos}} — comma-separated selected repos
- {{task.issueUrl}} — GitHub issue URL
- {{task.context}} — CLAUDE.md + file tree for each selected repo
- {{project.name}}, {{project.language}}
- {{project.fields.FIELD}} — options for a GitHub Project single-select field (ej: {{project.fields.priority}})
- {{variables.KEY}} — custom variables defined on the agent

Write a clear, actionable agent prompt based on the user's description. The prompt should tell the agent exactly what to analyze, what decisions to make, and what format to produce. Use markdown sections if the output needs structure. Return ONLY the prompt text — no preamble, no markdown code fences.`

function rewriteVars(text: string): string {
  return text
    .replaceAll('{{context.repos}}', '{{task.context}}')
    .replace(/\{\{\s*project\.field_options\./g, '{{project.fields.')
}

const migration: Migration = {
  id: '009-unify-template-syntax',
  description:
    'Rewrite agents.prompt + system_prompts.text to the unified {{...}} catalog (task.context, project.fields.*)',
  up(db) {
    const agents = db.query('SELECT id, prompt FROM agents').all() as {
      id: string
      prompt: string
    }[]
    for (const a of agents) {
      const updated = rewriteVars(a.prompt)
      if (updated !== a.prompt) {
        db.run('UPDATE agents SET prompt = ? WHERE id = ?', [updated, a.id])
      }
    }

    const prompts = db.query('SELECT id, name, text FROM system_prompts').all() as {
      id: string
      name: string
      text: string
    }[]
    for (const p of prompts) {
      let updated = rewriteVars(p.text)
      // Replace the seed catalog documented inside the "IA — Generar Prompt" prompt.
      if (p.name === 'IA — Generar Prompt') {
        updated = NEW_IA_GENERATE_PROMPT
      }
      if (updated !== p.text) {
        db.run('UPDATE system_prompts SET text = ? WHERE id = ?', [updated, p.id])
      }
    }
  },
}

export default migration
