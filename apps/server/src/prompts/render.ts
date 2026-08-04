// Resolves the effective prompt for a phase (override or default) and
// substitutes `{var}` placeholders from the given vars map. Unknown
// placeholders are preserved verbatim so authors can spot typos without
// crashing an in-flight run.
import type { ProviderConfig, StepType } from '@ia-flow/shared'
import { DEFAULT_PHASE_PROMPTS } from './defaults.js'

export function substituteVars(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match,
  )
}

export function renderPhasePrompt(
  step: StepType,
  config: ProviderConfig,
  vars: Record<string, string>,
): string {
  const override = config.phasePrompts?.[step]
  const template = override && override.trim().length > 0 ? override : DEFAULT_PHASE_PROMPTS[step]
  return substituteVars(template, vars)
}
