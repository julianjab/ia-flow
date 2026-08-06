import { Hono } from 'hono'
import { loadProviderConfig } from '../providers/index.js'
import { getProjectConfigFromDb } from '../db.js'
import { createLogger } from '../logger.js'

const log = createLogger('agents-assist')

const API_URL = 'https://api.anthropic.com/v1/messages'

function buildAuthHeader(): Record<string, string> {
  const oauthToken = Bun.env.CLAUDE_CODE_OAUTH_TOKEN
  const apiKey = Bun.env.ANTHROPIC_API_KEY
  if (oauthToken) return { Authorization: `Bearer ${oauthToken}` }
  if (apiKey) return { 'x-api-key': apiKey }
  throw new Error('No auth configured: set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY')
}

export const GENERATE_SYSTEM = `You are an expert at writing prompts for ia-flow agents. ia-flow is a task management system where AI agents receive context about a software development task and produce structured output for Claude Code to act on.

Available template variables:
- {{task.title}} — issue/task title
- {{task.description}} — full issue body
- {{task.type}} — "functional" | "technical"
- {{task.status}} — current workflow status
- {{task.repos}} — comma-separated selected repos
- {{task.issueUrl}} — GitHub issue URL
- {{task.issueNumber}} — issue number
- {{task.sections.NAME}} — named output section from a previous agent in the pipeline
- {{context.repos}} — CLAUDE.md content + file tree for each selected repo
- {{project.name}}, {{project.language}}
- {{project.field_options.priority}}, {{project.field_options.size}}, {{project.field_options.task_type}}
- {{variables.KEY}} — custom variables defined on the agent
- {{task.id}} — task ID (use in complete_task / fail_task tool calls)
- {{daemon_url}} — ia-flow daemon base URL (e.g. http://localhost:3001)

Write a clear, actionable agent prompt based on the user's description. The prompt should tell the agent exactly what to analyze, what decisions to make, and what format to produce. Use markdown sections if the output needs structure. Return ONLY the prompt text — no preamble, no markdown code fences.`

export const REFINE_SYSTEM = `You are an expert at improving prompts for ia-flow agents. ia-flow is a task management system where AI agents receive software task context and produce structured output.

Refine the provided prompt to be:
- Clearer and more specific in its instructions
- Better structured with markdown sections when helpful
- More actionable — concrete steps, not vague goals
- Preserve all template variables ({{...}}) exactly as-is

Return ONLY the improved prompt text — no preamble, no markdown code fences.`

export function createAgentsRouter() {
  const app = new Hono()

  app.post('/assist', async (c) => {
    let body: { mode: 'generate' | 'refine'; description?: string; currentPrompt?: string; agentId?: string; systemPromptIds?: string[] }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON in request body' }, 400)
    }

    const { mode, description, currentPrompt, agentId, systemPromptIds } = body

    if (mode === 'generate' && !description?.trim()) {
      return c.json({ error: 'description is required for generate mode' }, 400)
    }
    if (mode === 'refine' && !currentPrompt?.trim()) {
      return c.json({ error: 'currentPrompt is required for refine mode' }, 400)
    }

    const systemPrompt = mode === 'generate' ? GENERATE_SYSTEM : REFINE_SYSTEM
    const userMessage = mode === 'generate'
      ? `Agent ID: ${agentId || 'unknown'}\n\nDescription of what this agent should do:\n${description}`
      : [
          `Agent ID: ${agentId || 'unknown'}`,
          description?.trim() ? `\nInstructions for the refinement:\n${description}` : '',
          `\nCurrent prompt to refine:\n${currentPrompt}`,
        ].join('')

    try {
      const config = await loadProviderConfig()
      const { model, anthropicVersion } = config.anthropicApi
      const authHeader = buildAuthHeader()

      // Use only the auth-relevant betas — thinking/caching/context-management
      // betas require specific body params we don't send here.
      const beta = ['claude-code-20250219', 'oauth-2025-04-20'].join(',')

      const { systemPrompt: configSystemPrompt } = config.anthropicApi
      const extraBlocks = systemPromptIds?.length
        ? (getProjectConfigFromDb().systemPrompts ?? [])
            .filter(sp => systemPromptIds.includes(sp.id))
            .map(sp => ({ type: 'text', text: sp.text }))
        : []
      const systemBlocks = [
        ...(configSystemPrompt.length ? [{ type: 'text', text: configSystemPrompt[0].text }] : []),
        ...extraBlocks,
        { type: 'text', text: systemPrompt },
      ]

      const requestBody = {
        model,
        max_tokens: 16000,
        system: systemBlocks,
        messages: [{ role: 'user', content: userMessage }],
      }

      log.debug({ mode, agentId, model, system: systemBlocks, userMessage }, 'anthropic request')

      const t0 = Date.now()
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': anthropicVersion,
          'anthropic-beta': beta,
          ...authHeader,
        },
        body: JSON.stringify(requestBody),
      })

      log.debug({ status: res.status, ms: Date.now() - t0 }, 'anthropic response')

      if (!res.ok) {
        const text = await res.text()
        return c.json({ error: `Anthropic API error ${res.status}: ${text}` }, 500)
      }

      const data = await res.json() as { content: Array<{ type: string; text: string }> }
      const text = data.content.find(b => b.type === 'text')?.text ?? ''
      return c.json({ prompt: text.trim() })
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  return app
}
