// Qué dashboard le toca al runner seleccionado: el que alguien editó para él; si no, el que trae la
// web para su URL (`server:` de un archivo de `.config/dashboards/`); si no, el de defecto. Uno que
// no cumple el formato no tumba la pantalla: se cae al siguiente y se dice por qué.

import { type Dashboard, DashboardError, parseDashboard } from '@/features/inbox/view/dashboard'
import { DEFAULT_PRESET, PRESETS } from '@/features/inbox/view/presets'
import { loadOverride } from '@/features/inbox/view/storage'

/** Sin barra final ni mayúsculas: la identidad de un runner. `''` (el proxeado de Vite) es `local`. */
export function serverKey(base: string): string {
  return base.trim().replace(/\/+$/, '').toLowerCase() || 'local'
}

export type DashboardSource = 'override' | 'preset' | 'default'

export interface ResolvedDashboard {
  dashboard: Dashboard
  source: DashboardSource
  /** El YAML con el que se armó: lo que abre el editor. */
  text: string
  /** Por qué se descartó uno de más prioridad, si pasó. */
  warning?: string
}

/** El archivo de `.config/dashboards/` que declara este runner en su `server:`. */
function presetFor(key: string): string | undefined {
  return PRESETS.find((preset) => {
    if (preset.name === DEFAULT_PRESET) return false
    try {
      const server = parseDashboard(preset.text).server
      return [server ?? []].flat().some((candidate) => serverKey(candidate) === key)
    } catch {
      return false
    }
  })?.text
}

function defaultText(): string {
  const preset = PRESETS.find((candidate) => candidate.name === DEFAULT_PRESET)
  if (!preset) throw new Error('falta apps/web/.config/dashboards/default.yaml')
  return preset.text
}

export function resolveDashboard(key: string): ResolvedDashboard {
  let warning: string | undefined
  const candidates: Array<{ source: DashboardSource; text: string | null | undefined }> = [
    { source: 'override', text: loadOverride(key) },
    { source: 'preset', text: presetFor(key) },
    { source: 'default', text: defaultText() },
  ]
  for (const { source, text } of candidates) {
    if (!text) continue
    try {
      return { dashboard: parseDashboard(text), source, text, ...(warning ? { warning } : {}) }
    } catch (err) {
      if (!(err instanceof DashboardError) || source === 'default') throw err
      warning = `El dashboard ${source === 'override' ? 'editado' : 'de este runner'} no es válido: ${err.message}`
    }
  }
  throw new Error('sin dashboard')
}
