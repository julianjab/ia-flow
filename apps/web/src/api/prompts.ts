import axios from 'axios';
import type { StepType } from '@ia-flow/shared';

export interface PhaseVariable {
  name: string;
  description: string;
}

export interface PhasePrompt {
  step: StepType;
  prompt: string;
  defaultPrompt: string;
  isCustomized: boolean;
  variables: PhaseVariable[];
}

export interface GetPhasePromptsResponse {
  prompts: PhasePrompt[];
}

export async function getPhasePrompts(): Promise<PhasePrompt[]> {
  const { data } = await axios.get<GetPhasePromptsResponse>('/api/prompts');
  return data.prompts;
}

export async function updatePhasePrompt(step: StepType, prompt: string): Promise<PhasePrompt> {
  const { data } = await axios.put<PhasePrompt>(`/api/prompts/${step}`, { prompt });
  return data;
}

export async function resetPhasePrompt(step: StepType): Promise<PhasePrompt> {
  const { data } = await axios.delete<PhasePrompt>(`/api/prompts/${step}`);
  return data;
}
