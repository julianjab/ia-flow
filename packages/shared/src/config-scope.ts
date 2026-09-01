// Ámbito de una pieza de configuración — la frontera entre lo PROPIO y lo
// HEREDADO.
//
// Cuatro cosas se configuran hoy en dos niveles (agentes, reglas, acciones con
// nombre, tools definidas, system prompts) y las cinco usan la misma
// convención, en la base y en el wire:
//
//   projectId: null   → global. Visible desde todos los proyectos.
//   projectId: 'X'    → de X. Visible sólo desde X.
//
// La lectura de un proyecto es la UNIÓN de las dos —lo suyo más lo global— y
// la escritura sólo alcanza lo suyo. Eso es lo que hace que un ámbito no pueda
// romperle la configuración a otro: para tocar una global hay que pararse en
// General, que es donde se ve a quién más afecta el cambio.
//
// Vive acá y no en cada feature porque es contrato server↔web: el ámbito viaja
// por query (`?scope=global` / `?projectId=X`) y NUNCA se deduce del body, para
// que una escritura no pueda promover en silencio algo de proyecto a global.

/** Desde dónde se está mirando/escribiendo la configuración. */
export type ConfigScope = { kind: 'global' } | { kind: 'project'; projectId: string }

/** El querystring del ámbito. Una sola fuente para las cinco features: cuando
 *  cada una lo armaba a mano, un `scope=global` olvidado caía en el 400 del
 *  server en vez de ser imposible de escribir. */
export function scopeQuery(scope: ConfigScope): string {
  return scope.kind === 'global'
    ? 'scope=global'
    : `projectId=${encodeURIComponent(scope.projectId)}`
}

/** El `projectId` que una escritura en este ámbito tiene que grabar. */
export function scopeOwner(scope: ConfigScope): string | null {
  return scope.kind === 'global' ? null : scope.projectId
}

/**
 * ¿Esta pieza viene de arriba, mirada desde este ámbito?
 *
 * Global mirada desde un proyecto ⇒ heredada (se ve, no se toca). Desde
 * General nada es heredado: ahí las globales SON las propias.
 */
export function isInherited(owned: { projectId?: string | null }, scope: ConfigScope): boolean {
  return scope.kind === 'project' && (owned.projectId ?? null) === null
}
