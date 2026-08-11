import axios from 'axios'

export interface ToolDefinition {
  name: string
  description: string
  input_schema: object
}

export async function getTools(): Promise<ToolDefinition[]> {
  const { data } = await axios.get<ToolDefinition[]>('/api/tools')
  return data
}
