import { ANTHROPIC_API_URL, buildAnthropicAuthHeader } from '@ia-flow/ai-providers'
import type { SystemPromptDef, SystemPromptRef } from '@ia-flow/shared'
import type { ReadOnlyTool } from '@ia-flow/tools'
import type { IAgentRepository } from '../../domain/ports/IAgentRepository.js'
import type { IAssistCallerConfigRepository } from '../../domain/ports/IAssistCallerConfigRepository.js'
import type { IProjectRepository } from '../../domain/ports/IProjectRepository.js'
import type { ISystemPromptRepository } from '../../domain/ports/ISystemPromptRepository.js'
import { createLogger } from '../../logger.js'
import { loadProviderConfig } from '../provider-config.js'

const log = createLogger('use-case:assist-with-ai')

// Tope de vueltas del loop de `runFormFill` cuando corre con `readTools`: el
// modelo puede encadenar list_tasks → get_task_detail → search_tasks antes
// de llamar a `fill_form`, pero sin un techo un modelo que nunca converge
// deja el request colgado hasta que el cliente cancela. 6 alcanza para
// cualquier secuencia razonable de lectura + la llamada final.
const MAX_FORM_FILL_TURNS = 6

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string }

type AnthropicMessage = { role: 'user' | 'assistant'; content: string | AnthropicContentBlock[] }

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
  /** Sólo tiene efecto junto a `responseSchema`: tools de sólo lectura que el
   *  modelo puede llamar ANTES de `fill_form` (p. ej. las de
   *  `@ia-flow/tools/task/task-read.js` que usa `TaskChatUseCase`). Cuando
   *  vienen, `runFormFill` deja de forzar `fill_form` en el primer turno —
   *  fuerza `tool_choice: any` (alguna tool, cualquiera) y repite hasta que
   *  el modelo elige `fill_form`, hasta `MAX_FORM_FILL_TURNS`. Sin esto, el
   *  comportamiento es idéntico al de antes: un único turno forzado a
   *  `fill_form`. */
  readTools?: ReadOnlyTool[]
  /** Cuando el caller quiere poder cortar el upstream (p. ej. el asistente
   *  de tareas propaga el `AbortSignal` de la request HTTP entrante — ver
   *  `TaskChatUseCase`). Opcional y sin efecto en los caminos que no lo
   *  pasan; sólo lo lee `runFormFill` hoy. */
  signal?: AbortSignal
  /** Ver issue #225. Sólo se usa cuando `agentId` es un caller AD-HOC (no un
   *  AgentDefinition real) y `assist_caller_configs` NO tiene fila para él
   *  todavía — el caso de un deploy nuevo antes de que alguien cargue esa
   *  fila vía `PUT /api/assist-configs/:agentId`. Una fila real SIEMPRE gana
   *  sobre esto: es lo que hace que este fallback sea seguro por default y
   *  editable sin redeploy una vez que alguien lo necesita distinto. El
   *  caller es dueño de su propio texto (`TaskChatUseCase` trae el suyo) —
   *  `AssistWithAiUseCase` no conoce a ningún caller en particular. */
  fallbackSystemPrompts?: SystemPromptRef[]
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

interface AssistContext {
  resolvedProjectId: string
  availablePrompts: SystemPromptDef[]
  normalizedVars: Array<{ key: string; value: string }>
  resolvedAgentSysprompts: SystemPromptDef[]
  missingAgentSysprompts: string[]
  userMessage: string
  extraBlocks: Array<{ type: 'text'; text: string }>
  missingExtras: string[]
}

// Resuelve el `systemPrompts[]` de un AssistCallerConfig (issue #225) contra
// el catálogo del proyecto — mismo shape/semántica que `resolveSystemPromptBlocks`
// en @ia-flow/agent-engine (id string → catálogo, `{text}` → literal), pero
// no se reusa ese helper: toma un `AgentDefinition` + `ProjectConfig` como
// forma de entrada, y acá no hay ninguno de los dos — sólo un array de refs
// suelto y el catálogo que `buildContext` ya cargó.
// `includedIds` se muta: un id ya cubierto por `systemPromptIds` (el extra
// explícito del caller) no se duplica.
export function resolveCallerConfigBlocks(
  refs: SystemPromptRef[],
  availablePrompts: SystemPromptDef[],
  includedIds: Set<string>,
): { blocks: Array<{ type: 'text'; text: string }>; missing: string[] } {
  const blocks: Array<{ type: 'text'; text: string }> = []
  const missing: string[] = []
  for (const ref of refs) {
    if (typeof ref === 'string') {
      if (includedIds.has(ref)) continue
      const sp = availablePrompts.find((s) => s.id === ref)
      if (sp) {
        blocks.push({ type: 'text', text: sp.text })
        includedIds.add(ref)
      } else {
        missing.push(ref)
      }
    } else {
      blocks.push({ type: 'text', text: ref.text })
    }
  }
  return { blocks, missing }
}

function validateAssistInput(input: AssistInput): void {
  if (input.mode === 'generate' && !input.description?.trim()) {
    throw new AssistValidationError('description is required for generate mode')
  }
  if (input.mode === 'refine' && !input.currentPrompt?.trim()) {
    throw new AssistValidationError('currentPrompt is required for refine mode')
  }
}

function buildUserMessage(input: AssistInput, agentContextBlock: string): string {
  const { mode, agentId, description, currentPrompt } = input
  const baseUserMessage =
    mode === 'generate'
      ? `Agent ID: ${agentId || 'unknown'}\n\nDescription of what this agent should do:\n${description}`
      : [
          `Agent ID: ${agentId || 'unknown'}`,
          description?.trim() ? `\nInstructions for the refinement:\n${description}` : '',
          `\nCurrent prompt to refine:\n${currentPrompt}`,
        ].join('')
  return agentContextBlock ? `${agentContextBlock}\n\n${baseUserMessage}` : baseUserMessage
}

export class AssistWithAiUseCase {
  constructor(
    private systemPromptRepo: ISystemPromptRepository,
    private projectRepo: IProjectRepository,
    // Opcionales: sólo hace falta pasarlos para que un `agentId` ad-hoc
    // (ver issue #225) resuelva su config de `assist_caller_configs`. Sin
    // ellos (tests viejos, callers que no usan `agentId`) el use-case se
    // comporta exactamente igual que antes.
    private assistCallerConfigRepo?: IAssistCallerConfigRepository,
    private agentRepo?: IAgentRepository,
  ) {}

  // Un `agentId` ad-hoc (no un AgentDefinition real — ese ya resuelve sus
  // propios system prompts por su campo `systemPrompts[]`) puede tener una
  // fila en `assist_caller_configs`. Separado de `buildContext` para no
  // subirle la complejidad ciclomática — es una decisión propia (gate +
  // fallback), no sólo un cálculo derivado.
  private resolveCallerConfigBlocks(
    input: AssistInput,
    availablePrompts: SystemPromptDef[],
    includedIds: Set<string>,
  ): { blocks: Array<{ type: 'text'; text: string }>; missing: string[] } {
    const { agentId } = input
    const isRealAgent = agentId
      ? (this.agentRepo?.inScope().some((a) => a.id === agentId) ?? false)
      : false
    if (!agentId || isRealAgent) return { blocks: [], missing: [] }

    const callerConfig = this.assistCallerConfigRepo?.getById(agentId)
    // Sin fila todavía (deploy nuevo, nadie la cargó vía
    // PUT /api/assist-configs/:agentId), caé al fallback que el CALLER trajo
    // — nunca a "sin instrucciones" en silencio. Una fila real CON refs que
    // sí resuelven gana siempre, y una fila con `systemPrompts: []` a
    // propósito también gana (refs.length === 0 abajo, no entra al fallback).
    const refs = callerConfig
      ? (callerConfig.systemPrompts ?? [])
      : (input.fallbackSystemPrompts ?? [])
    if (!refs.length) return { blocks: [], missing: [] }

    const resolved = resolveCallerConfigBlocks(refs, availablePrompts, includedIds)
    if (resolved.blocks.length > 0) return resolved

    // La fila TENÍA refs pero ninguna resolvió (prompt borrado del catálogo,
    // catálogo de otro scope de proyecto, id mal escrito) — eso es distinto
    // de "vacío a propósito", y dejar el asistente sin rol/defensa por un
    // dato roto es peor que ignorar la fila rota y usar el fallback.
    if (!callerConfig || !input.fallbackSystemPrompts?.length) return resolved
    return resolveCallerConfigBlocks(input.fallbackSystemPrompts, availablePrompts, includedIds)
  }

  private buildContext(input: AssistInput, requestId: string): AssistContext {
    const { agentVariables, agentSystemPromptIds, systemPromptIds, projectId } = input
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
    const userMessage = buildUserMessage(input, agentContextBlock)

    const includedIds = new Set(systemPromptIds ?? [])
    const explicitBlocks = systemPromptIds?.length
      ? availablePrompts
          .filter((sp) => systemPromptIds.includes(sp.id))
          .map((sp) => ({ type: 'text' as const, text: sp.text }))
      : []
    const missingExtras = (systemPromptIds ?? []).filter(
      (id) => !availablePrompts.some((sp) => sp.id === id),
    )

    // Va ANTES de los bloques explícitos — mismo orden general→específico
    // que `resolveSystemPromptBlocks` en @ia-flow/agent-engine.
    const callerConfig = this.resolveCallerConfigBlocks(input, availablePrompts, includedIds)
    missingExtras.push(...callerConfig.missing)

    const extraBlocks = [...callerConfig.blocks, ...explicitBlocks]
    if (missingExtras.length) {
      log.warn(
        { requestId, missing: missingExtras, projectId: resolvedProjectId },
        'assist: extra system prompt ids not found',
      )
    }

    return {
      resolvedProjectId,
      availablePrompts,
      normalizedVars,
      resolvedAgentSysprompts,
      missingAgentSysprompts,
      userMessage,
      extraBlocks,
      missingExtras,
    }
  }

  private logStart(requestId: string, input: AssistInput, ctx: AssistContext): void {
    log.info(
      {
        requestId,
        mode: input.mode,
        agentId: input.agentId ?? null,
        currentPromptLen: input.currentPrompt?.length ?? 0,
        descriptionLen: input.description?.length ?? 0,
        agentVariableKeys: ctx.normalizedVars.map((v) => v.key),
        agentSystemPrompts: ctx.resolvedAgentSysprompts.map((sp) => ({
          id: sp.id,
          name: sp.name,
          textLen: sp.text.length,
        })),
        agentSystemPromptsMissing: ctx.missingAgentSysprompts,
        extraSystemPromptIds: input.systemPromptIds ?? [],
        userMessageLen: ctx.userMessage.length,
      },
      `assist: ${input.mode} start`,
    )
  }

  /** Tool-aware path: reuse the existing anthropic-api provider so we don't
   *  reimplement executeLoop / tool wiring / repoPaths / thinking. */
  private async runToolAware(
    input: AssistInput,
    ctx: AssistContext,
    meta: { requestId: string; t0: number; model: string },
  ): Promise<AssistResult> {
    const { requestId, t0, model } = meta
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
        taskDescription: input.description ?? '',
        taskType: 'assist',
        repos: Object.keys(repoPaths),
        repoPaths,
        prompt: ctx.userMessage,
        systemPromptBlocks: ctx.extraBlocks,
        tools: input.tools as string[],
      })
      const output = result.content.trim()
      log.info(
        {
          requestId,
          mode: input.mode,
          model,
          apiMs: Date.now() - tApiTool,
          totalMs: Date.now() - t0,
          tools: input.tools,
          outputLen: output.length,
        },
        `assist: ${input.mode} done (tool-aware)`,
      )
      return { prompt: output }
    } catch (err) {
      throw new AssistUpstreamError(
        `Tool-aware assist failed: ${err instanceof Error ? err.message : String(err)}`,
        500,
      )
    }
  }

  private async runPlainCompletion(
    input: AssistInput,
    ctx: AssistContext,
    meta: { requestId: string; t0: number; model: string; anthropicVersion: string },
  ): Promise<AssistResult> {
    const { requestId, t0, model, anthropicVersion } = meta
    const { mode, agentId } = input
    const beta = ['claude-code-20250219', 'oauth-2025-04-20'].join(',')
    const requestBody = {
      model,
      max_tokens: 16000,
      system: ctx.extraBlocks,
      messages: [{ role: 'user', content: ctx.userMessage }],
    }
    log.debug(
      { requestId, model, system: ctx.extraBlocks, userMessage: ctx.userMessage },
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

  async execute(input: AssistInput): Promise<AssistResult> {
    const requestId = crypto.randomUUID().slice(0, 8)
    const t0 = Date.now()

    validateAssistInput(input)

    const ctx = this.buildContext(input, requestId)
    this.logStart(requestId, input, ctx)

    const config = await loadProviderConfig()
    const { model, anthropicVersion } = config.anthropicApi

    if (input.tools?.length) {
      return this.runToolAware(input, ctx, { requestId, t0, model })
    }

    // Structured "form-fill" mode: forced tool_use with the caller's schema.
    if (input.responseSchema && typeof input.responseSchema === 'object') {
      return this.runFormFill({
        requestId,
        t0,
        mode: input.mode,
        agentId: input.agentId,
        model,
        anthropicVersion,
        systemBlocks: ctx.extraBlocks,
        userMessage: ctx.userMessage,
        responseSchema: input.responseSchema,
        readTools: input.readTools,
        signal: input.signal,
      })
    }

    return this.runPlainCompletion(input, ctx, { requestId, t0, model, anthropicVersion })
  }

  /** Un turno del loop de `runFormFill`: POSTea a Anthropic y devuelve el
   *  body parseado, o tira `AssistUpstreamError` si la respuesta no es 2xx. */
  private async postFormFillTurn(body: {
    model: string
    systemBlocks: Array<{ type: 'text'; text: string }>
    fillToolPrompt: { type: 'text'; text: string }
    messages: AnthropicMessage[]
    tools: Array<{ name: string; description: string; input_schema: unknown }>
    toolChoice: { type: 'any' } | { type: 'tool'; name: string }
    anthropicVersion: string
    signal?: AbortSignal
    logCtx: { requestId: string; mode: 'generate' | 'refine'; agentId?: string; turn: number }
  }): Promise<{
    content: AnthropicContentBlock[]
    usage?: Record<string, number>
    stop_reason?: string
  }> {
    const {
      model,
      systemBlocks,
      fillToolPrompt,
      messages,
      tools,
      toolChoice,
      anthropicVersion,
      signal,
      logCtx,
    } = body
    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': anthropicVersion,
        'anthropic-beta': ['claude-code-20250219', 'oauth-2025-04-20'].join(','),
        ...buildAnthropicAuthHeader(),
      },
      body: JSON.stringify({
        model,
        max_tokens: 16000,
        system: [...systemBlocks, fillToolPrompt],
        messages,
        tools,
        tool_choice: toolChoice,
      }),
      signal,
    })
    if (!res.ok) {
      const errText = await res.text()
      log.error(
        { ...logCtx, status: res.status, body: errText },
        'assist: anthropic API error (form-fill)',
      )
      throw new AssistUpstreamError(`Anthropic API error ${res.status}: ${errText}`, res.status)
    }
    return res.json()
  }

  /** Ejecuta cada `tool_use` del turno (contra `readTools`) y arma los
   *  `tool_result` correspondientes. Un error de una tool individual no
   *  aborta el loop: vuelve como texto de `tool_result` para que el modelo
   *  decida cómo seguir (reintentar, cambiar de enfoque, o contestar con lo
   *  que ya tiene). */
  private async runToolUses(
    toolUses: Extract<AnthropicContentBlock, { type: 'tool_use' }>[],
    readTools: ReadOnlyTool[],
  ): Promise<AnthropicContentBlock[]> {
    const results: AnthropicContentBlock[] = []
    for (const use of toolUses) {
      const tool = readTools.find((t) => t.name === use.name)
      let content: string
      try {
        content = tool
          ? await tool.execute(use.input)
          : `Tool '${use.name}' no está disponible en este contexto.`
      } catch (err) {
        content = `Error: ${err instanceof Error ? err.message : String(err)}`
      }
      results.push({ type: 'tool_result', tool_use_id: use.id, content })
    }
    return results
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
    readTools?: ReadOnlyTool[]
    signal?: AbortSignal
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
      signal,
    } = args
    const readTools = args.readTools ?? []

    const fillToolPrompt = {
      type: 'text' as const,
      text: FORM_FILL_INSTRUCTIONS,
    }
    const fillFormTool = {
      name: 'fill_form',
      description:
        'Pre-fill the form fields. Only include fields you can confidently infer from the user input; omit anything you would have to invent.',
      input_schema: responseSchema,
    }
    const tools = [
      ...readTools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      })),
      fillFormTool,
    ]
    // Sin `readTools` el único tool disponible ES `fill_form` — forzarlo
    // directamente preserva exactamente el comportamiento de antes (un
    // único turno). Con `readTools`, forzar `fill_form` de entrada le
    // impediría al modelo leer nada primero: `any` obliga a llamar ALGÚN
    // tool en cada turno (nunca responde en texto plano) sin decidir cuál,
    // así que el loop converge en `fill_form` cuando el modelo ya tiene lo
    // que necesita.
    const toolChoice = readTools.length
      ? ({ type: 'any' } as const)
      : ({ type: 'tool', name: 'fill_form' } as const)

    const messages: AnthropicMessage[] = [{ role: 'user', content: userMessage }]
    let toolCallCount = 0

    for (let turn = 0; turn < MAX_FORM_FILL_TURNS; turn++) {
      const data = await this.postFormFillTurn({
        model,
        systemBlocks,
        fillToolPrompt,
        messages,
        tools,
        toolChoice,
        anthropicVersion,
        signal,
        logCtx: { requestId, mode, agentId, turn },
      })

      const toolUses = data.content.filter(
        (b): b is Extract<AnthropicContentBlock, { type: 'tool_use' }> => b.type === 'tool_use',
      )
      const fillUse = toolUses.find((b) => b.name === 'fill_form')
      if (fillUse) {
        log.info(
          {
            requestId,
            mode,
            agentId: agentId ?? null,
            model,
            turn,
            toolCalls: toolCallCount,
            totalMs: Date.now() - t0,
            stopReason: data.stop_reason ?? null,
            usage: data.usage ?? null,
            fieldKeys: Object.keys(fillUse.input),
          },
          `assist: ${mode} done (form-fill)`,
        )
        return { fields: fillUse.input }
      }

      if (!toolUses.length) {
        log.warn(
          {
            requestId,
            mode,
            agentId,
            turn,
            stopReason: data.stop_reason ?? null,
            hasText: data.content.some((b) => b.type === 'text'),
          },
          'assist: form-fill did not return any tool_use block',
        )
        throw new AssistUpstreamError(
          'Model did not return structured fields (missing fill_form tool_use).',
          502,
        )
      }

      // El modelo pidió leer antes de contestar — ejecuta las tools y le
      // devuelve el resultado en el próximo turno.
      messages.push({ role: 'assistant', content: data.content })
      toolCallCount += toolUses.length
      messages.push({ role: 'user', content: await this.runToolUses(toolUses, readTools) })
    }

    log.error(
      { requestId, mode, agentId, turns: MAX_FORM_FILL_TURNS, toolCalls: toolCallCount },
      'assist: form-fill excedió MAX_FORM_FILL_TURNS sin devolver fill_form',
    )
    throw new AssistUpstreamError(
      'El asistente agotó los intentos de lectura sin completar la respuesta.',
      502,
    )
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
