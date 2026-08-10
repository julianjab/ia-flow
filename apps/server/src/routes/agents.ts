import type { SystemPromptDef } from '@ia-flow/shared'
import { Hono } from 'hono'
import { projectRepo } from '../composition/container.js'
import type { ISystemPromptRepository } from '../domain/ports/ISystemPromptRepository.js'
import { createLogger } from '../logger.js'
import { loadProviderConfig } from '../providers/index.js'

function normalizeAgentVariables(
  input: Array<{ key: string; value: string }> | Record<string, string> | undefined,
): Array<{ key: string; value: string }> {
  if (!input) return []
  if (Array.isArray(input)) return input.filter((v) => v.key?.trim())
  return Object.entries(input)
    .filter(([k]) => k.trim())
    .map(([key, value]) => ({ key, value }))
}

function truncate(text: string, max = 600): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}… [truncated ${text.length - max} chars]`
}

interface AgentContextInput {
  agentVariables?: Array<{ key: string; value: string }> | Record<string, string>
  agentSystemPromptIds?: string[]
  allSystemPrompts: SystemPromptDef[]
}

function buildAgentContextBlock(input: AgentContextInput): string {
  const sections: string[] = []

  const vars = normalizeAgentVariables(input.agentVariables)
  if (vars.length) {
    const lines = vars.map(
      (v) =>
        `- {{variables.${v.key}}} = ${v.value ? JSON.stringify(truncate(v.value, 300)) : '(empty)'}`,
    )
    sections.push(`### Agent variables (referenced as {{variables.KEY}})\n${lines.join('\n')}`)
  }

  const spIds = input.agentSystemPromptIds ?? []
  if (spIds.length) {
    const found = input.allSystemPrompts.filter((sp) => spIds.includes(sp.id))
    if (found.length) {
      const lines = found.map((sp) => `- **${sp.name}** (${sp.id}):\n${truncate(sp.text)}`)
      sections.push(
        `### Active system prompts (will be sent alongside this agent's prompt at runtime)\n${lines.join('\n\n')}`,
      )
    }
  }

  if (!sections.length) return ''
  return `## Agent context (do not repeat inside the prompt — it is already provided)\n\n${sections.join('\n\n')}`
}

const log = createLogger('agents-assist')

const API_URL = 'https://api.anthropic.com/v1/messages'

function buildAuthHeader(): Record<string, string> {
  const oauthToken = Bun.env.CLAUDE_CODE_OAUTH_TOKEN
  const apiKey = Bun.env.ANTHROPIC_API_KEY
  if (oauthToken) return { Authorization: `Bearer ${oauthToken}` }
  if (apiKey) return { 'x-api-key': apiKey }
  throw new Error('No auth configured: set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY')
}

export function createAgentsRouter(systemPromptRepo: ISystemPromptRepository) {
  const app = new Hono()

  app.post('/assist', async (c) => {
    const requestId = crypto.randomUUID().slice(0, 8)
    const t0 = Date.now()

    let body: {
      mode: 'generate' | 'refine'
      description?: string
      currentPrompt?: string
      agentId?: string
      systemPromptIds?: string[]
      agentVariables?: Array<{ key: string; value: string }> | Record<string, string>
      agentSystemPromptIds?: string[]
      projectId?: string
    }
    try {
      body = await c.req.json()
    } catch {
      log.warn({ requestId }, 'assist: invalid JSON in request body')
      return c.json({ error: 'Invalid JSON in request body' }, 400)
    }

    const {
      mode,
      description,
      currentPrompt,
      agentId,
      systemPromptIds,
      agentVariables,
      agentSystemPromptIds,
      projectId,
    } = body

    if (mode === 'generate' && !description?.trim()) {
      log.warn({ requestId, mode, agentId }, 'assist: missing description for generate')
      return c.json({ error: 'description is required for generate mode' }, 400)
    }
    if (mode === 'refine' && !currentPrompt?.trim()) {
      log.warn({ requestId, mode, agentId }, 'assist: missing currentPrompt for refine')
      return c.json({ error: 'currentPrompt is required for refine mode' }, 400)
    }

    const resolvedProjectId = projectId ?? projectRepo.getDefaultId()
    const availablePrompts = systemPromptRepo.listForRuntime(resolvedProjectId)
    const normalizedVars = normalizeAgentVariables(agentVariables)
    const resolvedAgentSysprompts = (agentSystemPromptIds ?? [])
      .map((id) => availablePrompts.find((sp) => sp.id === id))
      .filter((sp): sp is SystemPromptDef => !!sp)
    const missingAgentSysprompts = (agentSystemPromptIds ?? []).filter(
      (id) => !availablePrompts.some((sp) => sp.id === id),
    )

    const agentContextBlock = buildAgentContextBlock({
      agentVariables,
      agentSystemPromptIds,
      allSystemPrompts: availablePrompts,
    })

    const baseUserMessage =
      mode === 'generate'
        ? `Agent ID: ${agentId || 'unknown'}\n\nDescription of what this agent should do:\n${description}`
        : [
            `Agent ID: ${agentId || 'unknown'}`,
            description?.trim() ? `\nInstructions for the refinement:\n${description}` : '',
            `\nCurrent prompt to refine:\n${currentPrompt}`,
          ].join('')
    const userMessage = agentContextBlock
      ? `${agentContextBlock}\n\n${baseUserMessage}`
      : baseUserMessage

    log.info(
      {
        requestId,
        mode,
        agentId: agentId ?? null,
        currentPromptLen: currentPrompt?.length ?? 0,
        descriptionLen: description?.length ?? 0,
        agentVariableKeys: normalizedVars.map((v) => v.key),
        agentSystemPrompts: resolvedAgentSysprompts.map((sp) => ({
          id: sp.id,
          name: sp.name,
          textLen: sp.text.length,
        })),
        agentSystemPromptsMissing: missingAgentSysprompts,
        extraSystemPromptIds: systemPromptIds ?? [],
        userMessageLen: userMessage.length,
      },
      `assist: ${mode} start`,
    )

    try {
      const config = await loadProviderConfig()
      const { model, anthropicVersion } = config.anthropicApi
      const authHeader = buildAuthHeader()

      // Use only the auth-relevant betas — thinking/caching/context-management
      // betas require specific body params we don't send here.
      const beta = ['claude-code-20250219', 'oauth-2025-04-20'].join(',')

      const extraBlocks = systemPromptIds?.length
        ? availablePrompts
            .filter((sp) => systemPromptIds.includes(sp.id))
            .map((sp) => ({ type: 'text', text: sp.text }))
        : []
      const missingExtras = (systemPromptIds ?? []).filter(
        (id) => !availablePrompts.some((sp) => sp.id === id),
      )
      if (missingExtras.length) {
        log.warn(
          { requestId, missing: missingExtras, projectId: resolvedProjectId },
          'assist: extra system prompt ids not found',
        )
      }
      const systemBlocks = extraBlocks

      const requestBody = {
        model,
        max_tokens: 16000,
        system: systemBlocks,
        messages: [{ role: 'user', content: userMessage }],
      }

      log.debug(
        { requestId, model, system: systemBlocks, userMessage },
        'assist: anthropic request payload',
      )

      const tApi = Date.now()
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
      const apiMs = Date.now() - tApi

      if (!res.ok) {
        const errText = await res.text()
        log.error(
          { requestId, mode, agentId, status: res.status, apiMs, body: errText },
          'assist: anthropic API error',
        )
        return c.json({ error: `Anthropic API error ${res.status}: ${errText}` }, 500)
      }

      const data = (await res.json()) as {
        content: Array<{ type: string; text: string }>
        usage?: {
          input_tokens?: number
          output_tokens?: number
          cache_read_input_tokens?: number
          cache_creation_input_tokens?: number
        }
        stop_reason?: string
      }
      const text = data.content.find((b) => b.type === 'text')?.text ?? ''
      const output = text.trim()

      log.info(
        {
          requestId,
          mode,
          agentId: agentId ?? null,
          model,
          apiMs,
          totalMs: Date.now() - t0,
          stopReason: data.stop_reason ?? null,
          usage: data.usage ?? null,
          outputLen: output.length,
        },
        `assist: ${mode} done`,
      )
      log.debug({ requestId, output }, 'assist: output text')

      return c.json({ prompt: output })
    } catch (err) {
      log.error(
        { requestId, mode, agentId, totalMs: Date.now() - t0, err },
        'assist: unexpected error',
      )
      return c.json({ error: String(err) }, 500)
    }
  })

  return app
}
