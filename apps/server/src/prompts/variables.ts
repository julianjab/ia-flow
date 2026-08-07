import { type StepType, type VariableDefinition } from '@ia-flow/shared'
import { getVariableDefinitions } from '../variables/index.js'

export type PhaseVariable = Pick<VariableDefinition, 'key' | 'description'>

export function getPhaseVariablesForStep(step: StepType): PhaseVariable[] {
  return getVariableDefinitions('phase-prompt')
    .filter((v) => !v.phases || v.phases.includes(step))
    .map((v) => ({ key: v.key, description: v.description }))
}
