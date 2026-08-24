// ¿Este agente puede escribir? Se deriva de sus `tools[]` y de nada más.
//
// Es la ÚNICA fuente del permiso de escritura de un run, y vive del lado del
// engine a propósito: el provider elige DÓNDE aterriza el workspace, pero no
// si el agente puede escribir en él (ver `intersectWritePaths` en
// @ia-flow/shared, que intersecta lo que el provider propone contra esto).
import type { AgentToolEntry } from '@ia-flow/shared'

const WRITE_TOOLS = new Set(['fs_write', 'fs_edit', 'bash_run'])

export function hasWriteTools(agent: { tools?: AgentToolEntry[] }): boolean {
  const tools = agent.tools ?? []
  return tools.some((t) => WRITE_TOOLS.has(typeof t === 'string' ? t : t.name))
}
