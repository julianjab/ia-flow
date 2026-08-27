import axios from 'axios'

export type EnvVarKind = 'password' | 'text' | 'select'
// 'providers' faltaba: el server ya lo manda (IA_FLOW_REMOTE_HEALTH_*).
export type EnvVarGroup = 'anthropic' | 'github' | 'slack' | 'daemon' | 'providers' | 'server'

/** De dónde salió el valor que el server está usando. `null` = sin valor.
 *  'db' = guardado desde esta pantalla; 'env' = del ambiente del proceso.
 *  El entorno gana: lo guardado se usa cuando el entorno no lo define. */
export type EnvVarSource = 'db' | 'env' | null

export interface EnvVarState {
  isSet: boolean
  secret: boolean
  value: string | null
  source: EnvVarSource
  /** Hay valor guardado que NO se aplica: el entorno define otro y gana. */
  savedButUnused: boolean
  label: string
  description: string
  kind: EnvVarKind
  group: EnvVarGroup
  groupLabel: string
  options?: string[]
}

export async function getEnvVars(): Promise<Record<string, EnvVarState>> {
  const { data } = await axios.get<{ vars: Record<string, EnvVarState> }>('/api/env-vars')
  return data.vars
}

export async function updateEnvVars(patch: Record<string, string>): Promise<void> {
  await axios.put('/api/env-vars', patch)
}
