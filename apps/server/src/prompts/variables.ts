// Derived from the central template-variables registry in @ia-flow/shared.
// Exposed via /api/prompts so the phase editor UI can show variable chips.
import { getPhaseVariables, type StepType } from '@ia-flow/shared'

export interface PhaseVariable {
  name: string
  description: string
}

function forStep(step: StepType): PhaseVariable[] {
  return getPhaseVariables(step).map(v => ({ name: v.key, description: v.description }))
}

export const PHASE_VARIABLES: Record<StepType, PhaseVariable[]> = {
  'refine-functional': forStep('refine-functional'),
  'refine-technical':  forStep('refine-technical'),
  'implement':         forStep('implement'),
}
