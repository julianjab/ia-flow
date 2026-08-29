import type { Rule } from '@ia-flow/shared'

// `repoName` es una referencia lógica a `repos`, scopeada por el `projectId` de
// la propia regla — no una FK de SQL. Se valida acá y no en el schema porque
// necesita un lookup a la DB. Recibe el set de nombres válidos (ya scopeado)
// en vez de un port, para quedar como función pura: testeable sin DB e
// importable desde un test sin arrastrar `composition/container.js` (que abre
// una conexión SQLite y corre migraciones como side effect del import).
//
// Vivía en `agents-crud-validation.ts`: se mudó con la activación cuando la
// migración 059 la absorbió en `rules`.
export function repoNameError(rule: Rule, validRepoNames: Set<string>): string | null {
  if (!rule.repoName || !rule.projectId) return null
  if (!validRepoNames.has(rule.repoName)) {
    return `repoName '${rule.repoName}' no existe en el proyecto '${rule.projectId}'`
  }
  return null
}
