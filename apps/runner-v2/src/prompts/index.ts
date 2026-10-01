/**
 * El catálogo de system prompts del runner (`system-prompts.yaml`, embebido en el bundle): lo que
 * cualquier agente nombra por `id` en sus `systemPrompts`. Se le pasa al engine con los demás
 * catálogos (`boot.ts`); el engine resuelve cada `{ id }` al armar el agente y rompe la carga si no
 * existe.
 */
import type { SystemPromptCatalog } from '@ia-flow/agent-engine'
import entries from './system-prompts.yaml'

const byId = new Map(
  (entries as unknown as Array<{ id: string; text: string }>).map((entry) => [
    entry.id,
    entry.text,
  ]),
)

export const RUNNER_SYSTEM_PROMPTS: SystemPromptCatalog & { ids(): string[] } = {
  resolve: (id) => byId.get(id),
  ids: () => [...byId.keys()],
}
