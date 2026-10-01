/**
 * Las capacidades que trae el runner: quién cumple cada una cuando la config no dice otra cosa.
 * Son agentes chicos de la fuente global, embebidos en el runner (y en el bundle):
 *
 *   assistant   el asistente de la web (`POST /api/assistant`): sus tools son las `assistant_*`
 *               del runner y su respuesta la pinta la web — cambia con ellas, en este repo
 *   whenText    `text-classifier`: si un evento cumple un criterio en lenguaje natural
 *   fileFocus   `file-focus`: las partes de un archivo grande que pide `fs_read` + `focus`
 *   branchName  `branch-namer`: el nombre de la rama de una task sin `branchPrefix`
 *
 * Un deploy las pisa en `sources.capabilities` de su runner.yaml (`{ agent: <su id> }`), con un
 * agente propio en `sources.agents`. Un agente propio con el id de uno de éstos rompe el arranque:
 * se usa otro id y se apunta la capacidad a él.
 *
 * Abren con `{ id: agentIdentity }`: el texto lo pone la config (`systemPrompts` de runner.yaml),
 * no el runner. Un deploy que no lo define las corre sin él (`builtinCapabilityAgents`).
 */
import assistant from './assistant.yaml'
import branchNamer from './branch-namer.yaml'
import fileFocus from './file-focus.yaml'
import textClassifier from './text-classifier.yaml'

/** Los agentes de las capacidades, como documentos inline de la fuente global. */
export const BUILTIN_CAPABILITY_AGENTS: Record<string, unknown>[] = [
  assistant,
  textClassifier,
  fileFocus,
  branchNamer,
]

type SystemPromptRef = { id?: string; text?: string }

/** Los agentes de las capacidades con los `{ id }` que la config declara (`declared`): uno que no
 *  declara se omite, en vez de romper el arranque de un deploy que no lo necesita. */
export function builtinCapabilityAgents(declared: ReadonlySet<string>): Record<string, unknown>[] {
  return BUILTIN_CAPABILITY_AGENTS.map((doc) => ({
    ...doc,
    systemPrompts: ((doc.systemPrompts ?? []) as SystemPromptRef[]).filter(
      (ref) => ref.text !== undefined || ref.id === undefined || declared.has(ref.id),
    ),
  }))
}

/** Quién cumple cada capacidad por default: lo que `sources.capabilities` no declara. */
export const BUILTIN_CAPABILITIES: Record<string, Record<string, unknown>> = {
  assistant: { agent: 'assistant' },
  whenText: { agent: 'text-classifier' },
  fileFocus: { agent: 'file-focus' },
  branchName: { agent: 'branch-namer' },
}
