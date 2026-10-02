// Los dashboards que trae la web, uno por runner: los archivos de `apps/web/.config/dashboards/`.
// Se leen al compilar (son parte de la web, no del runner): un runner nuevo es un archivo nuevo
// ahí, con su `server:`. `default.yaml` es el de quien no tiene el suyo.

const FILES = import.meta.glob('../../../../.config/dashboards/*.yaml', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

export interface Preset {
  /** El nombre del archivo, sin la extensión. */
  name: string
  text: string
}

const nameOf = (path: string) => path.replace(/^.*\//, '').replace(/\.yaml$/, '')

export const PRESETS: Preset[] = Object.entries(FILES)
  .map(([path, text]) => ({ name: nameOf(path), text }))
  .sort((a, b) => a.name.localeCompare(b.name))

export const DEFAULT_PRESET = 'default'
