import axios from 'axios';
import type { ProjectConfig } from '@ia-flow/shared';

export interface ProjectConfigResponse {
  config: ProjectConfig | null;
  raw: string;
}

export async function fetchProjectConfig(): Promise<ProjectConfigResponse> {
  const { data } = await axios.get<ProjectConfigResponse>('/api/project-config');
  return data;
}

export async function saveProjectConfigRaw(raw: string): Promise<void> {
  await axios.put('/api/project-config/raw', { raw });
}
