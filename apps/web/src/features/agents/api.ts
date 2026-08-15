import axios from 'axios'

export async function assistAgent(body: {
  mode: 'generate' | 'refine'
  description?: string
  currentPrompt?: string
  agentId?: string
  systemPromptIds?: string[]
  agentVariables?: Array<{ key: string; value: string }>
  agentSystemPromptIds?: string[]
  templateContext?: 'system-prompt' | 'agent-prompt'
  projectId?: string
}): Promise<{ prompt: string }> {
  const res = await axios.post('/api/agents/assist', body)
  return res.data
}
