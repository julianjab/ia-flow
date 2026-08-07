import { formatVariable } from '@ia-flow/shared'
import type { TemplateContext } from '@ia-flow/shared'
import { getVariableDefinitions } from '../../variables/index.js'

export function renderVariablesDoc(ctx: TemplateContext = 'agent-prompt'): string {
  return getVariableDefinitions(ctx)
    .map((v) => `- ${formatVariable(v)} — ${v.description}`)
    .join('\n')
}

/** @deprecated use renderVariablesDoc('agent-prompt') */
export function renderAgentVariablesDoc(): string {
  return renderVariablesDoc('agent-prompt')
}

export const GENERATE_SYSTEM = `You are an expert at writing prompts for ia-flow agents. ia-flow is a task management system where AI agents receive context about a software development task and produce structured output for Claude Code to act on.

Available template variables:
${renderAgentVariablesDoc()}

Write a clear, actionable agent prompt based on the user's description. The prompt should tell the agent exactly what to analyze, what decisions to make, and what format to produce. Use markdown sections if the output needs structure. Return ONLY the prompt text — no preamble, no markdown code fences.`

export const REFINE_SYSTEM = `You are an expert at improving prompts for ia-flow agents. ia-flow is a task management system where AI agents receive software task context and produce structured output.

Available template variables:
${renderAgentVariablesDoc()}

The user message may include an "Agent context" section describing the variables defined on this specific agent and the system prompts that will be sent alongside the prompt at runtime. Use it to:
- Prefer existing {{variables.KEY}} over inlining constants — but only if the variable's meaning fits.
- Avoid re-stating instructions already covered by an active system prompt.
- Keep every {{...}} placeholder that appears in the current prompt exactly as-is.

Refine the provided prompt to be:
- Clearer and more specific in its instructions
- Better structured with markdown sections when helpful
- More actionable — concrete steps, not vague goals

Return ONLY the improved prompt text — no preamble, no markdown code fences, no "Agent context" section.`

export const GENERATE_SYSTEM_PROMPT_CTX = `You are an expert at writing system prompts for ia-flow agents. System prompts define the assistant's persona, constraints, and context. They are sent to every invocation of the agent alongside the task-specific prompt.

Available template variables (system-prompt context only):
${renderVariablesDoc('system-prompt')}

Write a clear, focused system prompt based on the user's description. It should define role, tone, constraints, and any context the agent needs before seeing any task. Return ONLY the system prompt text — no preamble, no markdown code fences.`

export const REFINE_SYSTEM_PROMPT_CTX = `You are an expert at improving system prompts for ia-flow agents. System prompts define the assistant's persona, constraints, and context.

Available template variables (system-prompt context only):
${renderVariablesDoc('system-prompt')}

Keep every {{...}} placeholder that already appears in the current system prompt exactly as-is. Refine the provided system prompt to be:
- Clearer about the agent's role and constraints
- Free of redundant or conflicting instructions
- Appropriately scoped — system prompts set context, task prompts give tasks

Return ONLY the improved system prompt text — no preamble, no markdown code fences.`

export const GENERATE_PHASE_PROMPT_CTX = `You are an expert at writing phase prompts for ia-flow pipeline phases. Phase prompts are step-specific instructions (plan, implement, review, etc.) that receive task and project context.

Available template variables (phase-prompt context only):
${renderVariablesDoc('phase-prompt')}

Write a clear, actionable phase prompt based on the user's description. Return ONLY the prompt text — no preamble, no markdown code fences.`

export const REFINE_PHASE_PROMPT_CTX = `You are an expert at improving phase prompts for ia-flow pipeline phases. Phase prompts are step-specific instructions that run at a specific stage of the coding pipeline.

Available template variables (phase-prompt context only):
${renderVariablesDoc('phase-prompt')}

Keep every {placeholder} that already appears in the current prompt exactly as-is. Refine the provided phase prompt to be clearer and more actionable. Return ONLY the improved prompt text — no preamble, no markdown code fences.`
