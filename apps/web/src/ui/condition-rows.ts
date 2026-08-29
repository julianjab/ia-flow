// Forma de una fila de ConditionRowsEditor. Vive fuera del `.vue` porque
// `<script setup>` no admite exports, y los dos consumidores (el `when` de un
// agente, las reglas de admisión de un agent-host) necesitan el tipo.
export interface ConditionRow {
  field: string
  op: string
  value: string
}
