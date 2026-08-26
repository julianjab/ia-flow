import type { DbRepoEntry } from '@ia-flow/agent-engine'
// Lo que un entrypoint puede tener resuelto ANTES de que se evalúe el
// composition root, y que el root debe usar en vez de construirlo él.
//
// Existe por un problema de forma, no de features: `container.ts` es un módulo
// con efectos al importarse, así que no puede recibir parámetros. La versión
// anterior lo resolvía haciéndole importar el loader del `runner.yaml` — o sea
// que el núcleo del server terminaba conociendo el formato de config de un
// deploy concreto, con la flecha de dependencia al revés.
//
// Acá la dirección se invierte: este módulo no sabe qué es un runner ni qué es
// un YAML. Declara **qué piezas** se pueden traer hechas; quién las trae, y de
// dónde las sacó, es asunto del entrypoint. Sustituir el `runner.yaml` por otra
// fuente mañana no toca una línea de `infrastructure/` ni de `composition/`.
import type { AgentDefinition, McpCatalogEntry, Project } from '@ia-flow/shared'

export interface PreloadedConfig {
  projects?: Project[]
  repos?: DbRepoEntry[]
  agents?: AgentDefinition[]
  mcp?: McpCatalogEntry[]
  /**
   * Si este proceso acepta que un gateway se anuncie y sondea su salud.
   * Ausente = sí, que es el comportamiento del server completo.
   */
  remoteProviders?: boolean
  /**
   * Si este proceso prepara terreno en disco para los runs (clones,
   * worktrees). Ausente = sí. Un entrypoint headless que trabaja por MCP lo
   * apaga, y con eso el provider devuelve un plan vacío: sin `git`, sin `cd`.
   */
  workspace?: boolean
}

let preloaded: PreloadedConfig = {}

/** Lo llama el entrypoint ANTES de importar el resto. Después no tiene efecto:
 *  el container ya se evaluó con lo que hubiera. */
export function setPreloadedConfig(config: PreloadedConfig): void {
  preloaded = config
}

export function getPreloadedConfig(): PreloadedConfig {
  return preloaded
}
