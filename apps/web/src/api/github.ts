import axios from 'axios';

export interface ProjectField {
  name: string;
  dataType: string;
  options: string[];
}

export interface ProjectMetaResponse {
  fields: ProjectField[];
  error?: string;
}

export async function getProjectMeta(refresh = false): Promise<ProjectMetaResponse> {
  const { data } = await axios.get<ProjectMetaResponse>(
    `/api/github/project-meta${refresh ? '?refresh=1' : ''}`,
  );
  return data;
}

export interface GithubOwner {
  login: string;
  type: 'user' | 'org';
}

export interface OwnersResponse {
  owners: GithubOwner[];
  error?: string;
}

export async function getOwners(refresh = false): Promise<OwnersResponse> {
  const { data } = await axios.get<OwnersResponse>(
    `/api/github/owners${refresh ? '?refresh=1' : ''}`,
  );
  return data;
}

export interface ReposResponse {
  repos: string[];
  error?: string;
}

export async function getRepos(owner: string, refresh = false): Promise<ReposResponse> {
  const params = new URLSearchParams({ owner });
  if (refresh) params.set('refresh', '1');
  const { data } = await axios.get<ReposResponse>(`/api/github/repos?${params.toString()}`);
  return data;
}
