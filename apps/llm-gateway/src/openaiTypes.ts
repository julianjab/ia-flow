/** Lo mínimo de la API de chat completions de OpenAI que el gateway entiende — sólo lo que lee o
 *  escribe, no el schema completo. */

export interface ImagePart {
  type: 'image_url'
  image_url: { url: string }
}

export interface TextPart {
  type: 'text'
  text: string
}

export type ContentPart = TextPart | ImagePart

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type ChatMessage =
  | { role: 'system' | 'developer'; content: string | ContentPart[] }
  | { role: 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content?: string | ContentPart[] | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string | ContentPart[] }

export interface ToolDefinition {
  type: 'function'
  function: { name: string; description?: string; parameters?: Record<string, unknown> }
}

export type ToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; function: { name: string } }

export interface ChatCompletionRequest {
  model?: string
  messages: ChatMessage[]
  stream?: boolean
  stream_options?: { include_usage?: boolean }
  max_tokens?: number
  max_completion_tokens?: number
  temperature?: number
  top_p?: number
  stop?: string | string[]
  tools?: ToolDefinition[]
  tool_choice?: ToolChoice
}

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter'

export interface Usage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}
