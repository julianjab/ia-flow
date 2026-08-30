// El contrato que comparten TODOS los forms de acción.
//
// Un form no recibe el tipo de acción: recibe la entrada entera y edita lo que
// es suyo. El que decide cuál se renderiza es `registry.ts`, igual que
// `providerForms/registry.ts` hace con el `providerConfig` de un agente.

/** Una entrada del `do[]` de una regla, o el `body` de una acción con nombre. */
export type ActionEntry = Record<string, unknown> & { action: string }

export interface ActionFormProps {
  entry: ActionEntry
  /** Los agentes del ámbito, para sugerir en el campo `agentId`. Nunca es
   *  autoridad: un agente que todavía no se creó tiene que poder nombrarse. */
  agentIds?: string[]
  /** Las acciones con nombre del ámbito, para el campo `ref`. */
  actionIds?: string[]
}

/** Un form NO emite la entrada entera: emite el delta. Reemplazarla haría que
 *  dos campos editados en el mismo tick se pisen, y borraría `continueOnError`,
 *  que vive fuera del union y lo edita el contenedor. */
export type ActionFormEmits = (e: 'patch', changes: Record<string, unknown>) => void
