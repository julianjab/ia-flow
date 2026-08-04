// Tool registry + agentic execution loop
// Add new tools by implementing Tool<TInput> and calling registerTool()

export interface ToolContext {
  repoPaths: Record<string, string>  // repo name → absolute path
}

export interface Tool<TInput = unknown> {
  name: string
  description: string
  input_schema: object  // JSON Schema for the input
  execute(input: TInput, ctx: ToolContext): Promise<string>
}

const registry = new Map<string, Tool>()

export function registerTool(tool: Tool): void {
  registry.set(tool.name, tool)
}

export function getToolDefinitions(): Array<{ name: string; description: string; input_schema: object }> {
  return [...registry.values()].map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }))
}

// ─── Agentic loop ─────────────────────────────────────────────────────────
// Handles tool_use blocks until stop_reason is end_turn or max_iters

export interface LoopOptions {
  maxIters?: number
  onToolCall?: (name: string, input: unknown) => void
  onToolResult?: (name: string, result: string) => void
}

type ApiMessage = { role: 'user' | 'assistant'; content: unknown }

// Compact history when it exceeds ~200k tokens (~800k chars). Uses Haiku to summarize
// all tool results into a "Key findings" block, preserving insights without raw bytes.
const COMPACTION_BUDGET_CHARS = 800_000

async function compactHistory(messages: ApiMessage[]): Promise<ApiMessage[]> {
  const { DEFAULT_COMPACTION_PROMPT } = await import('../prompts/defaults.js')
  const { loadProviderConfig } = await import('../providers/index.js')

  const oauthToken = Bun.env.CLAUDE_CODE_OAUTH_TOKEN
  const apiKey = Bun.env.ANTHROPIC_API_KEY
  const authHeader = oauthToken
    ? { Authorization: `Bearer ${oauthToken}` }
    : apiKey ? { 'x-api-key': apiKey } : null

  // Fallback: truncate tool results to 500 chars each
  if (!authHeader) {
    return messages.map((msg) => {
      if (msg.role !== 'user' || !Array.isArray(msg.content)) return msg
      return {
        ...msg,
        content: (msg.content as any[]).map((block) =>
          block.type === 'tool_result' && typeof block.content === 'string' && block.content.length > 500
            ? { ...block, content: block.content.slice(0, 500) + '\n[truncated]' }
            : block
        ),
      }
    })
  }

  const config = await loadProviderConfig()
  const compactionPrompt = config.compactionPrompt ?? DEFAULT_COMPACTION_PROMPT

  const toolResults: string[] = []
  for (const msg of messages) {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
    for (const block of msg.content as any[]) {
      if (block.type === 'tool_result' && typeof block.content === 'string') {
        toolResults.push(block.content)
      }
    }
  }

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...authHeader },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        system: compactionPrompt,
        messages: [{ role: 'user', content: toolResults.join('\n\n---\n\n').slice(0, 150_000) }],
      }),
    })
    if (!res.ok) throw new Error(`Haiku ${res.status}`)
    const data = await res.json() as any
    const summary = (data.content as any[]).filter((b: any) => b.type === 'text').map((b: any) => b.text as string).join('')

    // Keep: initial prompt + summary of findings + last assistant turn
    const initial = messages.slice(0, 1)
    const lastAssistant = messages.filter((m) => m.role === 'assistant').slice(-1)
    const summaryMsg: ApiMessage = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'compaction', content: `Key findings from previous exploration:\n${summary}` }],
    }
    const compacted = [...initial, summaryMsg, ...lastAssistant]
    console.warn(`[executeLoop] compacted: ${JSON.stringify(messages).length} → ${JSON.stringify(compacted).length} chars`)
    return compacted
  } catch (e) {
    console.warn('[executeLoop] compaction failed, keeping history:', e)
    return messages
  }
}

export async function executeLoop(
  fetchApi: (messages: ApiMessage[]) => Promise<any>,
  initialMessages: ApiMessage[],
  ctx: ToolContext,
  opts: LoopOptions = {},
): Promise<{ text: string; iters: number }> {
  const { maxIters = 10, onToolCall, onToolResult } = opts
  const messages = [...initialMessages]
  let iters = 0

  while (iters < maxIters) {
    iters++
    const histSize = JSON.stringify(messages).length
    const sendMessages = histSize > COMPACTION_BUDGET_CHARS
      ? await compactHistory(messages)
      : messages
    const response = await fetchApi(sendMessages)
    const stopReason: string = response.stop_reason

    // Collect text and tool_use blocks from response
    const contentBlocks: any[] = response.content ?? []
    messages.push({ role: 'assistant', content: contentBlocks })

    if (stopReason === 'end_turn') {
      const text = contentBlocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text as string)
        .join('')
      return { text, iters }
    }

    if (stopReason !== 'tool_use') {
      // Unexpected stop — return whatever text we have
      const text = contentBlocks.filter((b) => b.type === 'text').map((b) => b.text as string).join('')
      return { text, iters }
    }

    // Execute all tool_use blocks in parallel
    const toolUseBlocks = contentBlocks.filter((b) => b.type === 'tool_use')
    const toolResults = await Promise.all(
      toolUseBlocks.map(async (block) => {
        const tool = registry.get(block.name)
        onToolCall?.(block.name, block.input)

        let result: string
        if (!tool) {
          result = `Error: tool '${block.name}' not found`
        } else {
          try {
            result = await tool.execute(block.input, ctx)
          } catch (e) {
            result = `Error: ${e instanceof Error ? e.message : String(e)}`
          }
        }

        onToolResult?.(block.name, result)
        return { type: 'tool_result', tool_use_id: block.id, content: result }
      }),
    )

    messages.push({ role: 'user', content: toolResults })
  }

  throw new Error(`Tool loop exceeded maxIters (${maxIters})`)
}
