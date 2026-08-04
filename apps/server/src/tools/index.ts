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
    const response = await fetchApi(messages)
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
