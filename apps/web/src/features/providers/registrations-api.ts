import axios from 'axios'

// Mirrors toPublicRegistration() in apps/server/src/routes/provider-registrations-logic.ts
// — never carries the real token, just whether one is set.
export interface ProviderRegistration {
  id: string
  name: string
  baseUrl: string
  remoteKind: 'sync' | 'async'
  remoteName: string
  remoteDescription: string
  createdAt: string
  hasToken: boolean
}

export interface CreateProviderRegistrationInput {
  name: string
  baseUrl: string
  token: string
}

export async function listProviderRegistrations(): Promise<ProviderRegistration[]> {
  const { data } = await axios.get<{ registrations: ProviderRegistration[] }>(
    '/api/provider-registrations',
  )
  return data.registrations
}

export async function createProviderRegistration(
  input: CreateProviderRegistrationInput,
): Promise<ProviderRegistration> {
  const { data } = await axios.post<{ registration: ProviderRegistration }>(
    '/api/provider-registrations',
    input,
  )
  return data.registration
}

export async function deleteProviderRegistration(id: string): Promise<void> {
  await axios.delete(`/api/provider-registrations/${encodeURIComponent(id)}`)
}
