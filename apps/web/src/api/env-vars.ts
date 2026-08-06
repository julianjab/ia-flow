import axios from 'axios';

export interface EnvVarState {
  isSet: boolean;
  secret: boolean;
  value: string | null;
  label: string;
  description: string;
}

export async function getEnvVars(): Promise<Record<string, EnvVarState>> {
  const { data } = await axios.get<{ vars: Record<string, EnvVarState> }>('/api/env-vars');
  return data.vars;
}

export async function updateEnvVars(patch: Record<string, string>): Promise<void> {
  await axios.put('/api/env-vars', patch);
}
