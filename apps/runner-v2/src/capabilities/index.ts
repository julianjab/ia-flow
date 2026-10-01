/**
 * Las capacidades que trae el runner: quién cumple cada una cuando la config no dice otra cosa.
 * Son agentes chicos de la fuente global, embebidos en el runner (y en el bundle):
 *
 *   assistant   el asistente de la web (`POST /api/assistant`): sus tools son las `assistant_*`
 *               del runner y su respuesta la pinta la web — cambia con ellas, en este repo
 *   assistant.runner-improvements
 *               `runner-improvements`: otro agente del mismo asistente (la web deja elegirlo),
 *               que lee las trazas buscando fallas del proceso y propone issues en ia-flow
 *   whenText    `text-classifier`: si un evento cumple un criterio en lenguaje natural
 *   fileFocus   `file-focus`: las partes de un archivo grande que pide `fs_read` + `focus`
 *   branchName  `branch-namer`: el nombre de la rama de una task sin `branchPrefix`
 *
 * Un deploy las pisa en `sources.capabilities` de su runner.yaml (`{ agent: <su id> }`), con un
 * agente propio en `sources.agents`. Cada capacidad `assistant` o `assistant.<id>` es un agente del
 * asistente de la web: su entrada lleva además `label` (y `description`) para el selector, que el
 * runner saca antes de dársela al engine (`assistantAgents`). Un agente propio con el id de uno de éstos rompe el arranque:
 * se usa otro id y se apunta la capacidad a él.
 *
 * Sin identidad propia: lo que un provider exige en todo request (ej. "You are Claude Code…" en
 * `anthropic-api`) va en `providers.<id>.systemPrompts` de runner.yaml, y les llega igual.
 */
import { type AssistantAgent, DEFAULT_ASSISTANT_AGENT } from '@ia-flow/shared'
import assistant from './assistant.yaml'
import branchNamer from './branch-namer.yaml'
import fileFocus from './file-focus.yaml'
import runnerImprovements from './runner-improvements.yaml'
import textClassifier from './text-classifier.yaml'

/** Los agentes de las capacidades, como documentos inline de la fuente global. */
export const BUILTIN_CAPABILITY_AGENTS: Record<string, unknown>[] = [
  assistant,
  runnerImprovements,
  textClassifier,
  fileFocus,
  branchNamer,
]

/** Quién cumple cada capacidad por default: lo que `sources.capabilities` no declara. */
export const BUILTIN_CAPABILITIES: Record<string, Record<string, unknown>> = {
  assistant: {
    agent: 'assistant',
    label: 'Operación',
    description: 'Qué pasó, por qué y qué hacer',
  },
  'assistant.runner-improvements': {
    agent: 'runner-improvements',
    label: 'Mejoras del runner',
    description: 'Fallas del proceso → issues en ia-flow',
  },
  whenText: { agent: 'text-classifier' },
  fileFocus: { agent: 'file-focus' },
  branchName: { agent: 'branch-namer' },
}

/** Si la capacidad `name` es un agente del asistente: `assistant` o `assistant.<id>`. */
export function isAssistantCapability(name: string): boolean {
  return name === DEFAULT_ASSISTANT_AGENT || name.startsWith(`${DEFAULT_ASSISTANT_AGENT}.`)
}

/**
 * Los agentes del asistente de `capabilities`, y las capacidades sin lo que es sólo de la web
 * (`label`, `description`): el paso que las cumple no las acepta. El de siempre va primero; sin
 * `label`, el agente se nombra por su id.
 */
export function assistantAgents(capabilities: Record<string, Record<string, unknown>>): {
  capabilities: Record<string, Record<string, unknown>>
  agents: AssistantAgent[]
} {
  const agents: AssistantAgent[] = []
  const steps: Record<string, Record<string, unknown>> = {}
  for (const [name, node] of Object.entries(capabilities)) {
    if (!isAssistantCapability(name)) {
      steps[name] = node
      continue
    }
    const { label, description, ...step } = node
    steps[name] = step
    agents.push({
      id: name,
      label: typeof label === 'string' && label ? label : name.slice(name.indexOf('.') + 1),
      ...(typeof description === 'string' && description ? { description } : {}),
    })
  }
  agents.sort(
    (a, b) => Number(b.id === DEFAULT_ASSISTANT_AGENT) - Number(a.id === DEFAULT_ASSISTANT_AGENT),
  )
  return { capabilities: steps, agents }
}
