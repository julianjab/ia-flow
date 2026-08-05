import axios from 'axios';

export interface LocalRepo {
  name: string;
  path: string;
  type: string;
  hasGit?: boolean;
}

export interface LocalReposResponse {
  repos: LocalRepo[];
  error?: string;
}

export async function getLocalRepos(): Promise<LocalReposResponse> {
  const { data } = await axios.get<LocalReposResponse>('/api/repos');
  return data;
}
