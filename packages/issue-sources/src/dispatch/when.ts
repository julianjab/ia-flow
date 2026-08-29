// El evaluador del DSL `when` se mudó a `@ia-flow/rules`.
//
// Vivía acá porque sus dos consumidores eran `agent-engine` (selectAgent) y
// este paquete (project-filter.ts), y la dependencia real era agent-engine →
// issue-sources. Con el matcher de reglas aparece un tercer consumidor que no
// es dueño de ninguno de los otros dos, así que el evaluador pasó a su propio
// paquete y esto queda como re-export para no tocar los imports existentes.
export { condToOp, evalWhen } from '@ia-flow/rules'
