import type { Component } from 'vue'
import AgentActionForm from './AgentActionForm.vue'
import EmitActionForm from './EmitActionForm.vue'
import HttpActionForm from './HttpActionForm.vue'
import JsonActionForm from './JsonActionForm.vue'
import RefActionForm from './RefActionForm.vue'
import ScriptActionForm from './ScriptActionForm.vue'

// Registry: tipo de acción → el form que edita SU config.
//
// Mismo patrón que `features/agents/providerForms/registry.ts`: agregar un tipo
// con form propio es una entrada acá y un `.vue` al lado, sin tocar el
// contenedor. Sin entrada, `actionFormFor` devuelve `JsonActionForm` y el tipo
// queda editable como blob — que es lo que hace que un handler nuevo del daemon
// (la lista sale de `GET /api/rules/action-kinds`) sea usable sin esperar un
// release de la web.
//
// Se mantiene a mano en sintonía con `RuleActionSchema` (`packages/shared/src/
// rules.ts`). No hay acoplamiento en runtime: el server es dueño de qué tipos
// existen; esto sólo decide qué UI se dibuja.
const REGISTRY: Record<string, Component> = {
  agent: AgentActionForm,
  http: HttpActionForm,
  emit: EmitActionForm,
  script: ScriptActionForm,
  ref: RefActionForm,
}

export function actionFormFor(kind: string): Component {
  return REGISTRY[kind] ?? JsonActionForm
}

export function hasDedicatedForm(kind: string): boolean {
  return kind in REGISTRY
}

/** Cómo se llama cada tipo para un humano. Vive acá y no en el contenedor
 *  porque es lo mismo que hay que escribir al agregar un tipo. */
const LABELS: Record<string, string> = {
  agent: 'Correr un agente',
  http: 'Llamar a una API',
  emit: 'Emitir un evento',
  script: 'Correr un script del repo',
  ref: 'Usar una acción con nombre',
}

export function actionLabelFor(kind: string): string {
  return LABELS[kind] ?? kind
}

/**
 * Una acción nueva nace con los campos obligatorios de su tipo ya presentes,
 * para que el form no arranque en un estado que el server rechaza.
 *
 * También es lo que hace correcto CAMBIAR de tipo: se reemplaza la entrada en
 * vez de mergear, porque los campos de una `http` no significan nada en una
 * `emit` y arrastrarlos deja basura que el server rechaza sin que se vea.
 */
const BLANKS: Record<string, (defaults: BlankDefaults) => Record<string, unknown>> = {
  agent: (d) => ({ action: 'agent', agentId: d.agentId ?? '' }),
  http: () => ({ action: 'http', method: 'POST', url: '' }),
  emit: () => ({ action: 'emit', type: '' }),
  script: () => ({ action: 'script', runtime: 'bash', file: '' }),
  ref: () => ({ action: 'ref', actionId: '' }),
}

export interface BlankDefaults {
  agentId?: string
}

export function blankActionFor(
  kind: string,
  defaults: BlankDefaults = {},
): Record<string, unknown> {
  // Un tipo desconocido nace con sólo su discriminante: el fallback JSON lo
  // completa. Caer a `agent` guardaría una acción de un tipo que no es el que
  // se eligió.
  return BLANKS[kind]?.(defaults) ?? { action: kind }
}
