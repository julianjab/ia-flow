import { ANTHROPIC_API_URL, buildAnthropicAuthHeader } from '@ia-flow/ai-providers'
import type { SystemPromptDef } from '@ia-flow/shared'
import type { IProjectRepository } from '../../domain/ports/IProjectRepository.js'
import type { ISystemPromptRepository } from '../../domain/ports/ISystemPromptRepository.js'
import { createLogger } from '../../logger.js'
import { loadProviderConfig } from '../provider-config.js'

const log = createLogger('use-case:assist-with-ai')

export interface AssistInput {
  mode: 'generate' | 'refine'
  description?: string
  currentPrompt?: string
  agentId?: string
  systemPromptIds?: string[]
  agentVariables?: Array<{ key: string; value: string }> | Record<string, string>
  agentSystemPromptIds?: string[]
  projectId?: string
  // When set, the assist call runs through anthropicApiProvider with the
  // listed tool names + the given repoContext(s). Reuses the same tool
  // loop the AgentOrchestrator uses — no duplicate implementation here.
  tools?: string[]
  repoContexts?: Array<{ name: string; path: string }>
  // When set, the assist call runs in "form-fill" mode: the model is forced
  // to call a single `fill_form` tool whose `input_schema` is this JSON
  // Schema. The result comes back in `fields` (partial object matching the
  // schema) instead of `prompt`. The schema is owned by the calling form
  // (web) — the server passes it through opaquely.
  responseSchema?: unknown
}

export interface AssistResult {
  prompt?: string
  /** Populated when `responseSchema` was provided. Partial object whose
   *  keys correspond to form fields the model chose to pre-fill. */
  fields?: Record<string, unknown>
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

    // Tool-aware path: reuse the existing anthropic-api provider so we
    // don't reimplement executeLoop / tool wiring / repoPaths / thinking.
    if (input.tools?.length) {
      const repoPaths: Record<string, string> = {}
      for (const r of input.repoContexts ?? []) {
        if (r.path) repoPaths[r.name] = expandHome(r.path)
      }
      const tApiTool = Date.now()
      try {
        // Dynamic import to avoid a static cycle with composition/container.ts,
        // which instantiates this use case (same pattern as
        // `tools/index.ts::compactHistory`).
        const { anthropicApiProvider } = await import('../../composition/container.js')
        const result = await anthropicApiProvider.run({
          step: 'refine-functional',
          taskId: `assist-${requestId}`,
          taskTitle: `assist ${input.agentId ?? 'unknown'}`,
          taskDescription: description ?? '',
          taskType: 'assist',
          repos: Object.keys(repoPaths),
          repoPaths,
          prompt: userMessage,
          systemPromptBlocks: extraBlocks as Array<{ type: 'text'; text: string }>,
          tools: input.tools,
        })
        const output = result.content.trim()
        log.info(
          {
            requestId,
            mode,
            model,
            apiMs: Date.now() - tApiTool,
            totalMs: Date.now() - t0,
            tools: input.tools,
            outputLen: output.length,
          },
          `assist: ${mode} done (tool-aware)`,
        )
        return { prompt: output }
      } catch (err) {
        throw new AssistUpstreamError(
          `Tool-aware assist failed: ${err instanceof Error ? err.message : String(err)}`,
          500,
        )
      }
    }

    // Structured "form-fill" mode: forced tool_use with the caller's schema.
    if (input.responseSchema && typeof input.responseSchema === 'object') {
      return this.runFormFill({
        requestId,
        t0,
        mode,
        agentId,
        model,
        anthropicVersion,
        systemBlocks: extraBlocks as Array<{ type: 'text'; text: string }>,
        userMessage,
        responseSchema: input.responseSchema,
      })
    }

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
        ...buildAnthropicAuthHeader(),
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

  private async runFormFill(args: {
    requestId: string
    t0: number
    mode: 'generate' | 'refine'
    agentId?: string
    model: string
    anthropicVersion: string
    systemBlocks: Array<{ type: 'text'; text: string }>
    userMessage: string
    responseSchema: unknown
  }): Promise<AssistResult> {
    const {
      requestId,
      t0,
      mode,
      agentId,
      model,
      anthropicVersion,
      systemBlocks,
      userMessage,
      responseSchema,
    } = args

    const fillToolPrompt = {
      type: 'text' as const,
      text: FORM_FILL_INSTRUCTIONS,
    }
    const requestBody = {
      model,
      max_tokens: 16000,
      system: [...systemBlocks, fillToolPrompt],
      messages: [{ role: 'user', content: userMessage }],
      tools: [
        {
          name: 'fill_form',
          description:
            'Pre-fill the form fields. Only include fields you can confidently infer from the user input; omit anything you would have to invent.',
          input_schema: responseSchema,
        },
      ],
      tool_choice: { type: 'tool', name: 'fill_form' },
    }

    const tApi = Date.now()
    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': anthropicVersion,
        'anthropic-beta': ['claude-code-20250219', 'oauth-2025-04-20'].join(','),
        ...buildAnthropicAuthHeader(),
      },
      body: JSON.stringify(requestBody),
    })
    const apiMs = Date.now() - tApi

    if (!res.ok) {
      const errText = await res.text()
      log.error(
        { requestId, mode, agentId, status: res.status, apiMs, body: errText },
        'assist: anthropic API error (form-fill)',
      )
      throw new AssistUpstreamError(`Anthropic API error ${res.status}: ${errText}`, res.status)
    }

    const data = (await res.json()) as {
      content: Array<
        | { type: 'text'; text: string }
        | { type: 'tool_use'; name: string; input: Record<string, unknown> }
      >
      usage?: Record<string, number>
      stop_reason?: string
    }

    const toolUse = data.content.find(
      (b): b is { type: 'tool_use'; name: string; input: Record<string, unknown> } =>
        b.type === 'tool_use' && b.name === 'fill_form',
    )
    if (!toolUse) {
      log.warn(
        {
          requestId,
          mode,
          agentId,
          stopReason: data.stop_reason ?? null,
          hasText: data.content.some((b) => b.type === 'text'),
        },
        'assist: form-fill did not return a fill_form tool_use block',
      )
      throw new AssistUpstreamError(
        'Model did not return structured fields (missing fill_form tool_use).',
        502,
      )
    }

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
        fieldKeys: Object.keys(toolUse.input),
      },
      `assist: ${mode} done (form-fill)`,
    )

    return { fields: toolUse.input }
  }
}

const FORM_FILL_INSTRUCTIONS = [
  'You are pre-filling a UI form on behalf of the user.',
  'You MUST call the `fill_form` tool exactly once. Do not respond with plain text.',
  'Return only fields you can confidently infer from the user input and the context provided.',
  'Omit fields you cannot infer — do NOT invent values, placeholders or empty strings.',
  'If the user is refining an existing value, return the improved value; keep unrelated fields out.',
].join('\n')

function expandHome(p: string): string {
  if (p.startsWith('~/')) return `${Bun.env.HOME ?? ''}/${p.slice(2)}`
  return p
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
