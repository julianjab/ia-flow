import type { SystemPromptDef } from '@ia-flow/shared'
import type { IProjectRepository } from '../../domain/ports/IProjectRepository.js'
import type { ISystemPromptRepository } from '../../domain/ports/ISystemPromptRepository.js'
import { createLogger } from '../../logger.js'
import { loadProviderConfig } from '../provider-config.js'

const log = createLogger('use-case:assist-with-ai')
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'

export interface AssistInput {
  mode: 'generate' | 'refine'
  description?: string
  currentPrompt?: string
  agentId?: string
  systemPromptIds?: string[]
  agentVariables?: Array<{ key: string; value: string }> | Record<string, string>
  agentSystemPromptIds?: string[]
  projectId?: string
}

export interface AssistResult {
  prompt: string
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function normalizeAgentVariables(
  input: AssistInput['agentVariables'],
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

function buildAgentContextBlock(input: {
  agentVariables?: AssistInput['agentVariables']
  agentSystemPromptIds?: string[]
  allSystemPrompts: SystemPromptDef[]
}): string {
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

function buildAuthHeader(): Record<string, string> {
  const oauthToken = Bun.env.CLAUDE_CODE_OAUTH_TOKEN
  const apiKey = Bun.env.ANTHROPIC_API_KEY
  if (oauthToken) return { Authorization: `Bearer ${oauthToken}` }
  if (apiKey) return { 'x-api-key': apiKey }
  throw new Error('No auth configured: set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY')
}

// ─── Use Case ──────────────────────────────────────────────────────────────

export class AssistWithAiUseCase {
  constructor(
    private systemPromptRepo: ISystemPromptRepository,
    private projectRepo: IProjectRepository,
  ) {}

  async execute(input: AssistInput): Promise<AssistResult> {
    const requestId = crypto.randomUUID().slice(0, 8)
    const t0 = Date.now()
    const {
      mode,
      description,
      currentPrompt,
      agentId,
      systemPromptIds,
      agentVariables,
      agentSystemPromptIds,
      projectId,
    } = input

    if (mode === 'generate' && !description?.trim()) {
      throw new AssistValidationError('description is required for generate mode')
    }
    if (mode === 'refine' && !currentPrompt?.trim()) {
      throw new AssistValidationError('currentPrompt is required for refine mode')
    }

    const resolvedProjectId = projectId ?? this.projectRepo.getDefaultId()
    const availablePrompts = this.systemPromptRepo.visibleTo(resolvedProjectId)
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

    const config = await loadProviderConfig()
    const { model, anthropicVersion } = config.anthropicApi
    const beta = ['claude-code-20250219', 'oauth-2025-04-20'].join(',')
    const requestBody = {
      model,
      max_tokens: 16000,
      system: extraBlocks,
      messages: [{ role: 'user', content: userMessage }],
    }
    log.debug(
      { requestId, model, system: extraBlocks, userMessage },
      'assist: anthropic request payload',
    )

    const tApi = Date.now()
    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': anthropicVersion,
        'anthropic-beta': beta,
        ...buildAuthHeader(),
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
      throw new AssistUpstreamError(`Anthropic API error ${res.status}: ${errText}`, res.status)
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
    const output = (data.content.find((b) => b.type === 'text')?.text ?? '').trim()

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

    return { prompt: output }
  }
}

// ─── Errors ────────────────────────────────────────────────────────────────

export class AssistValidationError extends Error {
  readonly kind = 'validation' as const
}

export class AssistUpstreamError extends Error {
  readonly kind = 'upstream' as const
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}
