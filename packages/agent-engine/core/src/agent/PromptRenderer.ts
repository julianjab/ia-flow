import type { PipelineExecutionContext } from '../pipeline/Runnable.js'
import type { AgentVariableValue, SystemPromptRef } from './AgentDefinition.js'

/** De dónde salen los system prompts referenciados por `id` (ej. un catálogo en una base o en
 *  archivos). Sin catálogo, una referencia sin `text` inline se descarta. */
export interface SystemPromptCatalog {
  resolve(id: string): string | undefined
}

export interface RenderedPrompt {
  prompt: string
  systemPrompts: string[]
}

function getPath(root: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc == null || typeof acc !== 'object') return undefined
    return (acc as Record<string, unknown>)[key]
  }, root)
}

/**
 * Arma lo que el provider lee: el prompt con sus `{{path}}` resueltos contra el payload del
 * evento, `steps`, `variables` e `input` — mismo patrón que `Agent.interpolate` en ia-flow: un
 * placeholder que no resuelve se deja tal cual, fail-open —, y los system prompts, inline o del
 * catálogo. Ningún `Provider` conoce `{{...}}`: eso vive acá, una sola vez.
 */
export class PromptRenderer {
  constructor(private readonly catalog?: SystemPromptCatalog) {}

  render(
    prompt: string,
    ctx: PipelineExecutionContext,
    input: Record<string, unknown>,
    variables: Record<string, AgentVariableValue>,
    systemPrompts: SystemPromptRef[],
  ): RenderedPrompt {
    const payload =
      typeof ctx.event.payload === 'object' && ctx.event.payload !== null
        ? (ctx.event.payload as Record<string, unknown>)
        : {}
    const root: Record<string, unknown> = {
      ...payload,
      steps: ctx.steps,
      variables: renderedVariables(variables),
      input,
    }
    return {
      prompt: interpolate(prompt, root),
      systemPrompts: systemPrompts
        .map(
          (ref) => ref.text ?? (ref.id !== undefined ? this.catalog?.resolve(ref.id) : undefined),
        )
        .filter((text): text is string => text != null),
    }
  }
}

function interpolate(text: string, root: Record<string, unknown>): string {
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, path: string) => {
    const value = getPath(root, path)
    return value == null ? match : String(value)
  })
}

function renderedVariables(variables: Record<string, AgentVariableValue>): Record<string, string> {
  const rendered: Record<string, string> = {}
  for (const [key, value] of Object.entries(variables)) {
    rendered[key] = typeof value === 'string' ? value : (value.full ?? value.value)
  }
  return rendered
}
