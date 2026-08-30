// Forma de una fila de ConditionRowsEditor. Vive fuera del `.vue` porque
// `<script setup>` no admite exports, y sus consumidores —el `when` de un
// agente, el de una regla, las reglas de admisión de un agent-host— necesitan
// el tipo.
export interface ConditionRow {
  field: string
  op: string
  value: string
  /** Conector con la condición ANTERIOR. La primera fila no lo usa.
   *
   *  Está en la fila y no en un array paralelo porque un conector pertenece a
   *  la condición que introduce: cuando vivía aparte (`RuleEditorModal`
   *  mantenía un `logics: ('and'|'or')[]` en paralelo) bastaba con que una
   *  fila tuviera el campo vacío para que el filtro del serializador corriera
   *  los índices y los AND/OR se guardaran contra la condición equivocada. */
  logic?: 'and' | 'or'
}
