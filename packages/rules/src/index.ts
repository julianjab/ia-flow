// @ia-flow/rules — las primitivas puras de matching del engine.
//
// Sin I/O, sin estado, sin dependencias más allá de `@ia-flow/shared`. Sus
// consumidores (la selección de agentes en `agent-engine`, el filtro de
// proyectos en `issue-sources`, y el matcher de reglas) no se conocen entre sí,
// que es la razón de que esto sea un paquete y no un rincón de alguno de ellos.
export { matchScope } from './scope.js'
export type { MatchableScope, ScopeLocation } from './scope.js'
export { condToOp, evalWhen } from './when.js'
